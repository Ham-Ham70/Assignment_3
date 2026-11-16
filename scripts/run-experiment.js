#!/usr/bin/env node
// Run one Assignment 3 load-balancing experiment end to end:
//   1. optionally render + apply an Envoy policy (recreates the Envoy container)
//   2. optionally inject a fixed delay on one replica
//   3. fixed-rate HTTP load, then fixed-rate gRPC load (no retries)
//   4. collect the Prometheus per-replica snapshot for each interface
//
//   node scripts/run-experiment.js --label part-c --policy part-c \
//     --http-rate 40 --grpc-rate 40 --duration 45
//
//   node scripts/run-experiment.js --label least-request-delay --policy least-request \
//     --delay-replica b --delay-every 1 --delay-ms 100 --http-rate 30 --grpc-rate 30 --duration 45
//
// Client summaries land in results/<label>-{http,grpc}.json and the Prometheus
// snapshots in results/<label>-{http,grpc}-metrics.json.

const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
function flag(name) {
  return args.includes(name);
}

const LABEL = opt("--label");
const POLICY = opt("--policy");
const HTTP_RATE = Number(opt("--http-rate", 40));
const GRPC_RATE = Number(opt("--grpc-rate", 40));
const DURATION = Number(opt("--duration", 45));
const SETTLE = Number(opt("--settle", 8)); // seconds to let Prometheus scrape
const WINDOW = Number(opt("--window", 1)); // minutes
const DELAY_REPLICA = opt("--delay-replica");
const DELAY_EVERY = Number(opt("--delay-every", 1));
const DELAY_MS = Number(opt("--delay-ms", 100));
const ROOT = path.join(__dirname, "..");

if (!LABEL) {
  console.error("--label is required");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, cmdArgs) {
  execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit" });
}

async function waitEnvoyReady(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://localhost:9901/ready");
      const text = await res.text();
      if (text.includes("LIVE")) return true;
    } catch (_) {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error("Envoy did not become ready");
}

async function main() {
  console.log("=".repeat(72));
  console.log(`Experiment '${LABEL}'`);
  console.log(`  policy=${POLICY || "(unchanged)"}  http=${HTTP_RATE}/s grpc=${GRPC_RATE}/s for ${DURATION}s`);
  if (DELAY_REPLICA) console.log(`  delay on ${DELAY_REPLICA}: every ${DELAY_EVERY} -> ${DELAY_MS}ms`);
  console.log("=".repeat(72));

  if (POLICY && !flag("--skip-policy")) {
    console.log(`\n[1/5] Applying Envoy policy '${POLICY}' ...`);
    run("node", ["scripts/envoy-policy.js", POLICY, "--apply"]);
    await waitEnvoyReady();
    console.log("      Envoy ready.");
  }

  if (DELAY_REPLICA) {
    console.log(`\n[2/5] Injecting delay on replica ${DELAY_REPLICA.toUpperCase()} ...`);
    run("node", [
      "scripts/replica-chaos.js",
      DELAY_REPLICA,
      "--every",
      String(DELAY_EVERY),
      "--ms",
      String(DELAY_MS),
    ]);
  }

  console.log(`\n[3/5] HTTP load (${DURATION}s) ...`);
  run("node", [
    "scripts/loadgen.js",
    "--rate", String(HTTP_RATE),
    "--duration", String(DURATION),
    "--label", `${LABEL}-http`,
    "--out", `results/${LABEL}-http.json`,
  ]);
  await sleep(SETTLE * 1000);
  run("node", [
    "scripts/collect-metrics.js",
    "--label", `${LABEL}-http`,
    "--interface", "http",
    "--window", String(WINDOW),
    "--out", `results/${LABEL}-http-metrics.json`,
  ]);

  console.log(`\n[4/5] gRPC load (${DURATION}s) ...`);
  run("node", [
    "scripts/loadgen-grpc.js",
    "--rate", String(GRPC_RATE),
    "--duration", String(DURATION),
    "--label", `${LABEL}-grpc`,
    "--out", `results/${LABEL}-grpc.json`,
  ]);
  await sleep(SETTLE * 1000);
  run("node", [
    "scripts/collect-metrics.js",
    "--label", `${LABEL}-grpc`,
    "--interface", "grpc",
    "--window", String(WINDOW),
    "--out", `results/${LABEL}-grpc-metrics.json`,
  ]);

  if (DELAY_REPLICA) {
    console.log(`\n[5/5] Clearing delay on replica ${DELAY_REPLICA.toUpperCase()} ...`);
    run("node", ["scripts/replica-chaos.js", DELAY_REPLICA, "--clear"]);
  }

  console.log(`\nDone. Results in results/${LABEL}-*.json`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
