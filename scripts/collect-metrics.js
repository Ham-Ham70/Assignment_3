#!/usr/bin/env node
// Collect per-replica Prometheus results for one experiment run.
//
// Queries Prometheus directly (never through Envoy) and writes a JSON snapshot
// next to the client-side loadgen output, so the report can quote both the
// proxy/backend view and the client view.
//
//   node scripts/collect-metrics.js --label part-c --window 1
//
// Window is the look-back used by increase()/rate(); make it >= the run length.

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

const PROM = process.env.PROM_URL || "http://localhost:9090";
const LABEL = opt("--label", "run");
const WINDOW = Number(opt("--window", 1)); // minutes
const IFACE = opt("--interface", "both"); // http | grpc | both
const OUT = opt("--out", path.join("results", `${LABEL}-metrics.json`));
const REPLICAS = ["A", "B", "C"];

const round = (n, d = 2) => (n == null ? null : Number(Number(n).toFixed(d)));

async function promQuery(expr) {
  const url = `${PROM}/api/v1/query?query=${encodeURIComponent(expr)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Prometheus ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.status !== "success") throw new Error(`Prometheus error: ${JSON.stringify(data)}`);
  return data.data.result;
}

// Sum a per-replica counter increase over the window.
async function perReplicaIncrease(metric, extra = "") {
  const rows = await promQuery(
    `sum by (replica) (increase(${metric}{${extra}}[${WINDOW}m]))`
  );
  const out = {};
  for (const r of rows) out[r.metric.replica] = round(Number(r.value[1]), 1);
  return out;
}

// histogram_quantile over the window, grouped by replica.
async function perReplicaQuantile(metric, q, extra = "") {
  const rows = await promQuery(
    `histogram_quantile(${q}, sum by (le, replica) (rate(${metric}_bucket{${extra}}[${WINDOW}m])))`
  );
  const out = {};
  for (const r of rows) out[r.metric.replica] = round(Number(r.value[1]) * 1000, 3); // s -> ms
  return out;
}

async function perReplicaGauge(metric, extra = "") {
  const rows = await promQuery(`sum by (replica) (${metric}{${extra}})`);
  const out = {};
  for (const r of rows) out[r.metric.replica] = round(Number(r.value[1]), 3);
  return out;
}

// {replica: {status: count}} for non-OK responses.
async function errorsBy(metric, labelName, okValues, extra = "") {
  const rows = await promQuery(
    `sum by (replica, ${labelName}) (increase(${metric}{${extra}}[${WINDOW}m]))`
  );
  const out = {};
  for (const r of rows) {
    const val = r.metric[labelName];
    const count = Number(r.value[1]);
    if (count <= 0) continue;
    if (okValues.includes(val)) continue;
    out[r.metric.replica] = out[r.metric.replica] || {};
    out[r.metric.replica][val] = round(count, 1);
  }
  return out;
}

function shares(perReplica) {
  const total = REPLICAS.reduce((s, r) => s + (perReplica[r] || 0), 0);
  const out = {};
  for (const r of REPLICAS) out[r] = total ? round(((perReplica[r] || 0) / total) * 100, 1) : 0;
  return { total: round(total, 1), share_pct: out };
}

async function collectHttp() {
  // Exclude health checks and chaos/scrape noise so the share reflects only
  // the actual workload the load generator sends through Envoy.
  const job = 'job="secret-identity",route!~"/api/health|unmatched|/chaos/.*"';
  const requests = await perReplicaIncrease("http_requests_total", job);
  const { total, share_pct } = shares(requests);
  return {
    requests: requests,
    total: total,
    share_pct: share_pct,
    p50_ms: await perReplicaQuantile("http_request_duration_seconds", 0.5, job),
    p95_ms: await perReplicaQuantile("http_request_duration_seconds", 0.95, job),
    active_now: await perReplicaGauge("http_active_requests", job),
    errors_by_status: await errorsBy("http_requests_total", "status_code", ["200", "201", "204", "304"], job),
  };
}

async function collectGrpc() {
  const job = 'job="secret-identity-grpc"';
  const calls = await perReplicaIncrease("grpc_server_handled_total", job);
  const { total, share_pct } = shares(calls);
  return {
    calls: calls,
    total: total,
    share_pct: share_pct,
    p50_ms: await perReplicaQuantile("grpc_server_handling_seconds", 0.5, job),
    p95_ms: await perReplicaQuantile("grpc_server_handling_seconds", 0.95, job),
    active_now: await perReplicaGauge("grpc_server_in_flight_requests", job),
    errors_by_code: await errorsBy("grpc_server_handled_total", "grpc_code", ["OK"], job),
  };
}

async function main() {
  const snapshot = {
    label: LABEL,
    interface: IFACE,
    window_min: WINDOW,
    collected_at: new Date().toISOString(),
  };
  if (IFACE === "http" || IFACE === "both") snapshot.http = await collectHttp();
  if (IFACE === "grpc" || IFACE === "both") snapshot.grpc = await collectGrpc();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2));

  console.log(`Metrics for '${LABEL}' [${IFACE}] (window ${WINDOW}m) -> ${OUT}`);
  if (snapshot.http) {
    console.log(
      `  HTTP  req=${snapshot.http.total}  share=${JSON.stringify(snapshot.http.share_pct)}  p95=${JSON.stringify(snapshot.http.p95_ms)}`
    );
  }
  if (snapshot.grpc) {
    console.log(
      `  gRPC  calls=${snapshot.grpc.total}  share=${JSON.stringify(snapshot.grpc.share_pct)}  p95=${JSON.stringify(snapshot.grpc.p95_ms)}`
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
