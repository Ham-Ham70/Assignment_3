#!/usr/bin/env node
// Part D failure/recovery experiment with Envoy active health checks.
//
//   node scripts/experiment-healthcheck.js
//
// Env knobs (all optional):
//   RATE=30 TOTAL_S=75 STOP_AT=25 RESTART_AT=50 POLL_MS=1000 LABEL=healthcheck
//   POLICY=healthchecks  (rendered + applied unless NO_APPLY=1)
//
// Timeline (seconds from load start):
//   0 .. STOP_AT        baseline, all three replicas healthy
//   STOP_AT             docker stop replica B
//   STOP_AT .. RESTART  B is down; Envoy ejects it after unhealthy_threshold
//   RESTART_AT          docker start replica B
//   RESTART_AT .. END   Envoy re-admits B after healthy_threshold successes
//
// Every POLL_MS it samples Envoy's own endpoint health (/clusters), the active
// health-check counters and the Prometheus per-replica request rate, then
// writes a timeline JSON next to the load generator output.
//
// The `healthchecks` policy renders STATIC endpoints so the stopped replica
// stays in the cluster and the ACTIVE HEALTH CHECK is what ejects it (Docker
// DNS would otherwise remove the endpoint first — see scripts/envoy-policy.js).

const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PROM = process.env.PROM_URL || "http://localhost:9090";
const ADMIN = process.env.ENVOY_ADMIN || "http://localhost:9901";
const RATE = Number(process.env.RATE || 30);
const TOTAL_S = Number(process.env.TOTAL_S || 75);
const STOP_AT = Number(process.env.STOP_AT || 25);
const RESTART_AT = Number(process.env.RESTART_AT || 50);
const POLL_MS = Number(process.env.POLL_MS || 1000);
const LABEL = process.env.LABEL || "healthcheck";
const POLICY = process.env.POLICY || "healthchecks";
const NO_APPLY = process.env.NO_APPLY === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 2) => (n == null ? null : Number(Number(n).toFixed(d)));

function docker(args, opts = {}) {
  return execFileSync("docker", args, { encoding: "utf8", ...opts }).trim();
}

// Non-blocking docker call: `docker stop` waits for the container's grace
// period, and we do not want that to stall the sampling loop.
function dockerAsync(args) {
  return spawn("docker", args, { stdio: "ignore" });
}

async function adminText(filter) {
  const res = await fetch(`${ADMIN}/stats?filter=${encodeURIComponent(filter)}`);
  return res.text();
}

function parseStats(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([\w.]+):\s*(\d+)$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

// { A: {ip, status}, ... } from Envoy's own cluster view (both clusters).
// STATIC endpoints have no hostname, so map the socket address back to the
// replica through the container IPs captured at the start of the run.
async function endpointHealth(ipToReplica) {
  const data = await fetch(`${ADMIN}/clusters?format=json`).then((r) => r.json());
  const result = { http: {}, grpc: {} };
  for (const c of data.cluster_statuses || []) {
    const key = c.name === "app_http" ? "http" : c.name === "app_grpc" ? "grpc" : null;
    if (!key) continue;
    for (const h of c.host_statuses || []) {
      const ip = h.address?.socket_address?.address;
      const name = (h.hostname || "").replace("app-", "").toUpperCase() || ipToReplica[ip];
      if (!name) continue;
      const hs = h.health_status || {};
      // Envoy keeps eds_health_status=HEALTHY for static endpoints; the active
      // health check result is reported in failed_active_health_check.
      result[key][name] = {
        ip,
        status: hs.failed_active_health_check === true ? "UNHEALTHY" : "HEALTHY",
        active_hc_timeout: hs.active_hc_timeout === true,
      };
    }
  }
  return result;
}

function resolveReplicaIps() {
  const ipToReplica = {};
  for (const r of ["a", "b", "c"]) {
    try {
      const ip = docker([
        "inspect", "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        `secret-identity-app-${r}`,
      ]);
      ipToReplica[ip] = r.toUpperCase();
    } catch (_) {
      /* container missing */
    }
  }
  return ipToReplica;
}

async function promRates() {
  const expr =
    'sum by (replica) (rate(http_requests_total{job="secret-identity",route="/api/characters"}[20s]))';
  const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(expr)}`);
  const data = await res.json();
  const out = { A: 0, B: 0, C: 0 };
  for (const r of data.data.result || []) out[r.metric.replica] = round(Number(r.value[1]), 2);
  return out;
}

function containerState(name) {
  try {
    return docker(["inspect", "-f", "{{.State.Status}}", name]);
  } catch (_) {
    return "gone";
  }
}

function waitForEnvoy(timeoutMs = 30000) {
  const start = Date.now();
  return (async () => {
    while (Date.now() - start < timeoutMs) {
      try {
        const r = await fetch(`${ADMIN}/ready`);
        if (r.ok) return true;
      } catch (_) {
        /* not up yet */
      }
      await sleep(1000);
    }
    return false;
  })();
}

async function main() {
  console.log("=".repeat(72));
  console.log("Health-check failure/recovery experiment");
  console.log(
    `  rate=${RATE}/s  total=${TOTAL_S}s  stop B at ${STOP_AT}s  restart B at ${RESTART_AT}s`
  );
  console.log("=".repeat(72));

  if (!NO_APPLY) {
    console.log(`\n[1/4] Applying '${POLICY}' policy ...`);
    try {
      execFileSync("node", ["scripts/envoy-policy.js", POLICY, "--apply"], {
        cwd: ROOT,
        stdio: "inherit",
      });
    } catch (err) {
      console.error("Failed to apply policy (is Docker running?):", err.message);
      process.exit(1);
    }
    if (!(await waitForEnvoy())) {
      console.error("Envoy admin did not become ready.");
      process.exit(1);
    }
    // Let the first health-check round settle so the baseline is all-HEALTHY.
    await sleep(5000);
  } else {
    console.log("\n[1/4] Skipping policy apply (NO_APPLY=1)");
  }

  console.log("\n[2/4] Resolving replica IPs and baseline endpoint health:");
  const ipToReplica = resolveReplicaIps();
  console.log("  " + JSON.stringify(ipToReplica));
  console.log("  " + JSON.stringify(await endpointHealth(ipToReplica)));

  console.log(`\n[3/4] Starting HTTP load (${TOTAL_S}s) and sampling ...\n`);

  const child = spawn(
    "node",
    [
      "scripts/loadgen.js",
      "--rate", String(RATE),
      "--duration", String(TOTAL_S),
      "--label", LABEL,
      "--timeline",
      "--out", `results/${LABEL}-http.json`,
    ],
    { cwd: ROOT, stdio: "ignore" }
  );
  let childExited = false;
  child.on("exit", () => {
    childExited = true;
  });

  const timeline = [];
  const t0 = Date.now();
  let stopped = false;
  let restarted = false;
  let ejectedAt = null;
  let readmittedAt = null;

  while (true) {
    const t = (Date.now() - t0) / 1000;
    if (t >= TOTAL_S) break;

    if (!stopped && t >= STOP_AT) {
      stopped = true;
      console.log(`  t=${t.toFixed(1)}s  >>> docker stop secret-identity-app-b`);
      dockerAsync(["stop", "-t", "2", "secret-identity-app-b"]);
    }
    if (!restarted && t >= RESTART_AT) {
      restarted = true;
      console.log(`  t=${t.toFixed(1)}s  >>> docker start secret-identity-app-b`);
      dockerAsync(["start", "secret-identity-app-b"]);
    }

    let health = { http: {}, grpc: {} };
    let rate = {};
    let hc = {};
    let upstream = {};
    try {
      health = await endpointHealth(ipToReplica);
    } catch (_) {}
    try {
      rate = await promRates();
    } catch (_) {}
    try {
      hc = parseStats(await adminText("cluster.app_http.health_check"));
    } catch (_) {}
    try {
      upstream = parseStats(await adminText("cluster.app_http.upstream_rq"));
    } catch (_) {}

    const bState = containerState("secret-identity-app-b");
    const bHttp = health.http.B;
    const bStatus = bHttp ? bHttp.status : "absent";

    if (stopped && !restarted && bStatus !== "HEALTHY" && ejectedAt == null) {
      ejectedAt = t;
      console.log(`  t=${t.toFixed(1)}s  *** B ejected by Envoy (status=${bStatus})`);
    }
    if (restarted && bStatus === "HEALTHY" && ejectedAt != null && readmittedAt == null) {
      readmittedAt = t;
      console.log(`  t=${t.toFixed(1)}s  *** B re-admitted by Envoy`);
    }

    timeline.push({
      t: round(t, 1),
      phase: t < STOP_AT ? "baseline" : t < RESTART_AT ? "down" : "recovery",
      b_container: bState,
      b_http_status: bStatus,
      b_http_timeout: health.http.B ? health.http.B.active_hc_timeout : null,
      b_grpc_status: health.grpc.B ? health.grpc.B.status : "absent",
      health_http: Object.fromEntries(
        Object.entries(health.http).map(([k, v]) => [k, v.status])
      ),
      hc_attempt: hc["cluster.app_http.health_check.attempt"] ?? null,
      hc_failure: hc["cluster.app_http.health_check.failure"] ?? null,
      hc_network_failure: hc["cluster.app_http.health_check.network_failure"] ?? null,
      hc_success: hc["cluster.app_http.health_check.success"] ?? null,
      upstream_rq_total: upstream["cluster.app_http.upstream_rq_total"] ?? null,
      upstream_rq_5xx: upstream["cluster.app_http.upstream_rq_5xx"] ?? null,
      rate,
    });
    console.log(
      `  t=${t.toFixed(1).padStart(5)}s  B=${bState.padEnd(8)} http=${bStatus.padEnd(9)}  ` +
        `hc(att=${hc["cluster.app_http.health_check.attempt"] ?? "?"},fail=${
          hc["cluster.app_http.health_check.failure"] ?? "?"
        },net=${hc["cluster.app_http.health_check.network_failure"] ?? "?"})  ` +
        `rq=${upstream["cluster.app_http.upstream_rq_total"] ?? "?"}(5xx=${
          upstream["cluster.app_http.upstream_rq_5xx"] ?? "?"
        })  rate=${JSON.stringify(rate)}`
    );
    await sleep(POLL_MS);
  }

  // Wait (bounded) for the load generator to finish and flush its JSON.
  const waitStart = Date.now();
  while (!childExited && Date.now() - waitStart < 30000) await sleep(250);

  // Client-side view: which seconds carried failures and how each replica
  // was used in each phase (authoritative for the report).
  let client = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "results", `${LABEL}-http.json`), "utf8"));
    const buckets = raw.timeline || [];
    const failSeconds = buckets.filter((b) => b.fail > 0).map((b) => b.t);
    const phaseTotals = { baseline: {}, down: {}, recovery: {} };
    for (const b of buckets) {
      const phase = b.t < STOP_AT ? "baseline" : b.t < RESTART_AT ? "down" : "recovery";
      for (const [rep, n] of Object.entries(b.by_replica || {})) {
        phaseTotals[phase][rep] = (phaseTotals[phase][rep] || 0) + n;
      }
    }
    client = {
      sent: raw.requests_sent,
      successes: raw.successes,
      failures: raw.failures,
      success_rate_pct: raw.success_rate_pct,
      client_p50_ms: raw.client_p50_ms,
      client_p95_ms: raw.client_p95_ms,
      client_p99_ms: raw.client_p99_ms,
      status_counts: raw.status_counts,
      replica_counts: raw.replica_counts,
      first_failure_s: failSeconds.length ? failSeconds[0] : null,
      last_failure_s: failSeconds.length ? failSeconds[failSeconds.length - 1] : null,
      failure_window_s:
        failSeconds.length ? failSeconds[failSeconds.length - 1] - failSeconds[0] + 1 : 0,
      replica_by_phase: phaseTotals,
    };
  } catch (e) {
    console.error("Could not read client results:", e.message);
  }

  const bDownSample = timeline.find((s) => s.b_container === "exited");
  const bDownAt = bDownSample ? bDownSample.t : null;
  const bUpSample = restarted
    ? timeline.find((s) => s.phase === "recovery" && s.b_container === "running")
    : null;
  const bUpAt = bUpSample ? bUpSample.t : null;

  const summary = {
    label: LABEL,
    policy: POLICY,
    rate: RATE,
    total_s: TOTAL_S,
    stop_at_s: STOP_AT,
    restart_at_s: RESTART_AT,
    health_check: {
      type: "http_health_check /api/health (HTTP cluster), tcp_health_check (gRPC cluster)",
      interval: "2s",
      no_traffic_interval: "2s",
      unhealthy_interval: "2s",
      timeout: "1s",
      unhealthy_threshold: 3,
      healthy_threshold: 2,
      endpoints: "STATIC (IPs pinned at render time)",
    },
    b_down_at_s: bDownAt,
    b_up_at_s: bUpAt,
    ejected_at_s: round(ejectedAt, 1),
    // Measured from the stop command and from the moment B actually stopped.
    ejection_delay_from_cmd_s: ejectedAt != null ? round(ejectedAt - STOP_AT, 1) : null,
    ejection_delay_s:
      ejectedAt != null && bDownAt != null ? round(ejectedAt - bDownAt, 1) : null,
    readmitted_at_s: round(readmittedAt, 1),
    readmission_delay_s: readmittedAt != null ? round(readmittedAt - RESTART_AT, 1) : null,
    client,
    timeline,
  };

  fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "results", `${LABEL}-timeline.json`),
    JSON.stringify(summary, null, 2)
  );

  console.log("\n[4/4] Summary");
  console.log(
    `  B down at ${bDownAt != null ? bDownAt + "s" : "n/a"}; ` +
      `ejected at ${ejectedAt != null ? ejectedAt.toFixed(1) + "s" : "n/a"} ` +
      `(${summary.ejection_delay_s}s after B stopped, ${summary.ejection_delay_from_cmd_s}s after the stop command)`
  );
  console.log(
    `  B up at ${bUpAt != null ? bUpAt + "s" : "n/a"}; ` +
      `re-admitted at ${readmittedAt != null ? readmittedAt.toFixed(1) + "s" : "n/a"} ` +
      `(${summary.readmission_delay_s}s after restart)`
  );
  console.log(`  wrote results/${LABEL}-timeline.json and results/${LABEL}-http.json`);
  if (client) {
    console.log(
      `  client: ${client.successes}/${client.sent} ok (${client.success_rate_pct}%), ` +
        `${client.failures} failed, 503 window ${client.first_failure_s}-${client.last_failure_s}s ` +
        `(${client.failure_window_s}s)`
    );
    console.log(`  client replica by phase: ${JSON.stringify(client.replica_by_phase)}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
