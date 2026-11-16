#!/usr/bin/env node
// Diagnostic: watch Envoy endpoint health + health-check counters over time.
//   node scripts/hc-watch.js [seconds] [intervalMs]
const ADMIN = process.env.ENVOY_ADMIN || "http://localhost:9901";
const SECONDS = Number(process.argv[2] || 20);
const INTERVAL = Number(process.argv[3] || 2000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snapshot() {
  const c = await fetch(`${ADMIN}/clusters?format=json`).then((r) => r.json());
  const cl = (c.cluster_statuses || []).find((x) => x.name === "app_http");
  const health = (cl?.host_statuses || []).map((h) => `${h.hostname}=${h.health_status?.eds_health_status}`);
  const t = await fetch(`${ADMIN}/stats?filter=cluster.app_http.health_check`).then((r) => r.text());
  const m = {};
  for (const line of t.split("\n")) {
    const mm = line.match(/^cluster\.app_http\.health_check\.(\w+):\s*(\d+)/);
    if (mm) m[mm[1]] = Number(mm[2]);
  }
  return { health, m };
}

(async () => {
  const start = Date.now();
  let prev = null;
  while ((Date.now() - start) / 1000 < SECONDS) {
    const { health, m } = await snapshot();
    const t = ((Date.now() - start) / 1000).toFixed(1);
    const d = prev ? m.attempt - prev : 0;
    console.log(`t=${t.padStart(5)}s  [${health.join(" ")}]  attempt=${m.attempt} (+${d}) success=${m.success} failure=${m.failure} net=${m.network_failure} healthy=${m.healthy}`);
    prev = m.attempt;
    await sleep(INTERVAL);
  }
})();
