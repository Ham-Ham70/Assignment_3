#!/usr/bin/env node
// Fixed-rate gRPC load generator for Assignment 3.
//
// Opens ONE channel to Envoy and fires unary GetCharacters calls on a fixed
// schedule. Because the Envoy listener is HTTP/2, Envoy routes each call
// separately, so the responses' served_by_replica field shows the spread.
//
//   node scripts/loadgen-grpc.js --target localhost:10001 --rate 20 \
//     --duration 60 --out results/part-a-grpc.json --label part-a-grpc
//
// No retries and no circuit breaker on purpose.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const TARGET = args.target || "localhost:10001";
const RATE = Number(args.rate || 20);
const DURATION_S = Number(args.duration || 30);
const CONCURRENCY = Number(args.concurrency || 256);
const LABEL = args.label || "grpc";
const OUT = args.out || path.join("results", `${LABEL}.json`);

const PROTO_PATH = path.join(__dirname, "..", "proto", "game.proto");
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDefinition).secretidentity;
const Client = proto.SecretIdentityService;

const TOTAL = Math.max(1, Math.round(RATE * DURATION_S));
const INTERVAL_MS = 1000 / RATE;

const latencies = [];
const codeCounts = {};
const replicaCounts = {};
const sampleTraceIds = [];

let sent = 0;
let successes = 0;
let failures = 0;
let inflight = 0;
let maxInflight = 0;
let throttled = 0;

const traceId = () => crypto.randomBytes(16).toString("hex");

const client = new Client(TARGET, grpc.credentials.createInsecure(), {
  "grpc.max_receive_message_length": 10 * 1024 * 1024,
  "grpc.keepalive_time_ms": 30000,
});

function fire() {
  sent++;
  const tid = traceId();
  if (sampleTraceIds.length < 3) sampleTraceIds.push(tid);
  const started = process.hrtime.bigint();
  inflight++;
  if (inflight > maxInflight) maxInflight = inflight;

  const md = new grpc.Metadata();
  md.set("x-trace-id", tid);
  md.set("x-request-id", tid);

  client.GetCharacters({ alignment_filter: "" }, md, (err, resp) => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    latencies.push(ms);
    inflight--;
    if (err) {
      const code = err.code !== undefined ? String(err.code) : "UNKNOWN";
      const name = grpc.status[err.code] || code;
      codeCounts[name] = (codeCounts[name] || 0) + 1;
      failures++;
      return;
    }
    codeCounts.OK = (codeCounts.OK || 0) + 1;
    successes++;
    const replica = (resp && resp.served_by_replica) || "-";
    replicaCounts[replica] = (replicaCounts[replica] || 0) + 1;
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

const round = (n, d = 2) => Number(n.toFixed(d));

async function main() {
  console.log("=".repeat(72));
  console.log(`gRPC load: ${LABEL}`);
  console.log(`  target      ${TARGET} (single channel, ${RATE} calls/s for ${DURATION_S}s)`);
  console.log(`  requests    ${TOTAL}, interval ${INTERVAL_MS.toFixed(2)} ms, concurrency cap ${CONCURRENCY}`);
  console.log("=".repeat(72));

  const t0 = Date.now();
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
  const elapsedMs = Date.now() - t0;
  const elapsedS = elapsedMs / 1000;

  const sorted = latencies.slice().sort((a, b) => a - b);
  const summary = {
    label: LABEL,
    interface: "grpc",
    target: TARGET,
    method: "GetCharacters",
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
    status_counts: codeCounts,
    replica_counts: replicaCounts,
    sample_trace_ids: sampleTraceIds,
  };

  console.log("\nResult");
  console.log(`  sent ${sent} @ ${summary.achieved_rate}/s (target ${RATE})`);
  console.log(`  success ${successes} (${summary.success_rate_pct}%), failures ${failures}`);
  console.log(`  client p50 ${summary.client_p50_ms} ms, p95 ${summary.client_p95_ms} ms, max ${summary.client_max_ms} ms`);
  console.log(`  per replica ${JSON.stringify(replicaCounts)}`);
  console.log(`  codes ${JSON.stringify(codeCounts)}`);
  console.log(`  sample trace ids ${sampleTraceIds.join(", ")}`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${OUT}`);

  client.close();
}

main();
