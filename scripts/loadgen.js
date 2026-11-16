#!/usr/bin/env node
// Fixed-rate HTTP load generator for Assignment 3.
//
// Sends requests on a fixed schedule and does NOT wait for a response before
// sending the next one (bounded only by a safety in-flight cap). No retries and
// no circuit breaker, so the numbers reflect Envoy + the replicas only.
//
//   node scripts/loadgen.js --url http://localhost:10000 --path /api/characters \
//     --rate 40 --duration 60 --out results/part-a-http.json --label part-a-http
//
// Read-only by default (GET /api/characters) so it is safe to repeat.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const BASE = (args.url || "http://localhost:10000").replace(/\/$/, "");
const ROUTE = args.path || "/api/characters";
const RATE = Number(args.rate || 20);
const DURATION_S = Number(args.duration || 30);
const CONCURRENCY = Number(args.concurrency || 256);
const TIMEOUT_MS = Number(args.timeout || 10000);
const LABEL = args.label || "http";
const OUT = args.out || path.join("results", `${LABEL}.json`);
const INTERFACE = args.interface || "http";
const TIMELINE = Boolean(args.timeline);

const URL = BASE + ROUTE;
const TOTAL = Math.max(1, Math.round(RATE * DURATION_S));
const INTERVAL_MS = 1000 / RATE;

const latencies = [];
const statusCounts = {};
const replicaCounts = {};
const errorCounts = {};
const sampleTraceIds = [];

let sent = 0;
let successes = 0;
let failures = 0;
let inflight = 0;
let maxInflight = 0;
let throttled = 0;
let t0 = 0;
const timeline = [];

// One bucket per second of wall-clock, used to show failover timing.
function bucket() {
  const s = Math.max(0, Math.floor((Date.now() - t0) / 1000));
  while (timeline.length <= s) {
    timeline.push({ t: timeline.length, sent: 0, ok: 0, fail: 0, by_replica: {} });
  }
  return timeline[s];
}

const traceId = () => crypto.randomBytes(16).toString("hex");

function record({ status, replica, ms, error }) {
  latencies.push(ms);
  const b = TIMELINE ? bucket() : null;
  if (error) {
    errorCounts[error] = (errorCounts[error] || 0) + 1;
    failures++;
    if (b) b.fail++;
    return;
  }
  statusCounts[status] = (statusCounts[status] || 0) + 1;
  replicaCounts[replica] = (replicaCounts[replica] || 0) + 1;
  if (status >= 200 && status < 400) {
    successes++;
    if (b) {
      b.ok++;
      b.by_replica[replica] = (b.by_replica[replica] || 0) + 1;
    }
  } else {
    failures++;
    if (b) b.fail++;
  }
}

function fire() {
  sent++;
  if (TIMELINE) bucket().sent++;
  const tid = traceId();
  if (sampleTraceIds.length < 3) sampleTraceIds.push(tid);
  const started = process.hrtime.bigint();
  inflight++;
  if (inflight > maxInflight) maxInflight = inflight;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  fetch(URL, {
    method: "GET",
    headers: {
      "x-trace-id": tid,
      "x-request-id": tid,
      traceparent: `00-${tid}-${crypto.randomBytes(8).toString("hex")}-01`,
    },
    signal: controller.signal,
  })
    .then(async (res) => {
      const replica = res.headers.get("x-replica-id") || "-";
      await res.arrayBuffer(); // drain so the socket is reused
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      record({ status: res.status, replica, ms });
    })
    .catch((err) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      record({ error: err.name === "AbortError" ? "timeout" : err.name || "error", ms });
    })
    .finally(() => {
      clearTimeout(timer);
      inflight--;
    });
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function round(n, d = 2) {
  return Number(n.toFixed(d));
}

async function main() {
  console.log("=".repeat(72));
  console.log(`HTTP load: ${LABEL}`);
  console.log(`  target      ${URL}`);
  console.log(`  rate        ${RATE} req/s for ${DURATION_S}s (${TOTAL} requests, interval ${INTERVAL_MS.toFixed(2)} ms)`);
  console.log(`  concurrency safety cap ${CONCURRENCY}, timeout ${TIMEOUT_MS} ms`);
  console.log("=".repeat(72));

  const t0start = Date.now();
  t0 = t0start;
  await new Promise((resolve) => {
    function pump() {
      const now = Date.now();
      while (sent < TOTAL && now >= t0 + sent * INTERVAL_MS) {
        if (inflight >= CONCURRENCY) {
          throttled++;
          break;
        }
        fire();
      }
      if (sent >= TOTAL) {
        if (inflight === 0) return resolve();
        return setTimeout(pump, 20);
      }
      setTimeout(pump, Math.max(0, t0 + sent * INTERVAL_MS - Date.now()));
    }
    pump();
  });
  const elapsedMs = Date.now() - t0start;
  const elapsedS = elapsedMs / 1000;

  const sorted = latencies.slice().sort((a, b) => a - b);
  const summary = {
    label: LABEL,
    interface: INTERFACE,
    url: URL,
    target_rate: RATE,
    duration_s: DURATION_S,
    started_at: new Date(t0).toISOString(),
    ended_at: new Date().toISOString(),
    elapsed_s: round(elapsedS),
    requests_sent: sent,
    achieved_rate: round(sent / elapsedS),
    successes,
    failures,
    success_rate_pct: round((successes / sent) * 100),
    client_p50_ms: round(percentile(sorted, 0.5), 3),
    client_p95_ms: round(percentile(sorted, 0.95), 3),
    client_p99_ms: round(percentile(sorted, 0.99), 3),
    client_max_ms: round(sorted[sorted.length - 1] || 0, 3),
    max_in_flight: maxInflight,
    throttled_ticks: throttled,
    status_counts: statusCounts,
    replica_counts: replicaCounts,
    error_counts: errorCounts,
    sample_trace_ids: sampleTraceIds,
  };
  if (TIMELINE) summary.timeline = timeline;

  console.log("\nResult");
  console.log(`  sent ${sent} @ ${summary.achieved_rate}/s (target ${RATE})`);
  console.log(`  success ${successes} (${summary.success_rate_pct}%), failures ${failures}`);
  console.log(`  client p50 ${summary.client_p50_ms} ms, p95 ${summary.client_p95_ms} ms, max ${summary.client_max_ms} ms`);
  console.log(`  per replica ${JSON.stringify(replicaCounts)}`);
  console.log(`  statuses ${JSON.stringify(statusCounts)}  errors ${JSON.stringify(errorCounts)}`);
  console.log(`  sample trace ids ${sampleTraceIds.join(", ")}`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${OUT}`);
}

main();
