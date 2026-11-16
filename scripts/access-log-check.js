#!/usr/bin/env node
// Cross-check one experiment's distribution against Envoy's OWN access logs.
//
//   node scripts/access-log-check.js --label weighted --interface http
//
// Reads results/<label>-<interface>.json for the run window and the client-side
// replica counts, then asks Elasticsearch how many Envoy access-log events in
// that exact window were served by each replica. This validates the client-side
// numbers against the proxy's independent record.

const fs = require("fs");
const path = require("path");

const ES = process.env.ES_URL || "http://localhost:9200";
const INDEX = process.env.ES_INDEX || "secret-identity-logs-*";
const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

const LABEL = opt("--label", "weighted");
const IFACE = opt("--interface", "http");
// Filebeat stamps @timestamp when it reads the line, which lags the request by
// a few seconds, so extend the upper bound a little to avoid missing the tail.
const LAG_MS = Number(opt("--lag", 30)) * 1000;
const CLIENT = JSON.parse(
  fs.readFileSync(path.join(ROOT, "results", `${LABEL}-${IFACE}.json`), "utf8")
);

async function search(body) {
  const res = await fetch(`${ES}/${INDEX}/_search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ES ${res.status}: ${await res.text()}`);
  return res.json();
}

function shares(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const out = {};
  for (const k of Object.keys(counts).sort()) {
    out[k] = total ? Number(((counts[k] / total) * 100).toFixed(1)) : 0;
  }
  return out;
}

async function main() {
  const body = {
    size: 0,
    track_total_hits: true,
    query: {
      bool: {
        filter: [
          { term: { log_source: "envoy" } },
          { term: { api: IFACE } },
          {
            range: {
              "@timestamp": {
                gte: CLIENT.started_at,
                lte: new Date(Date.parse(CLIENT.ended_at) + LAG_MS).toISOString(),
              },
            },
          },
        ],
      },
    },
    aggs: {
      by_replica: { terms: { field: "replica", size: 10 } },
      by_upstream: { terms: { field: "upstream_host", size: 10 } },
      by_code: { terms: { field: "response_code", size: 10 } },
    },
  };

  const r = await search(body);
  const total = r.hits.total.value;
  const envoy = {};
  for (const b of r.aggregations.by_replica.buckets) envoy[b.key] = b.doc_count;
  const upstream = {};
  for (const b of r.aggregations.by_upstream.buckets) upstream[b.key] = b.doc_count;
  const codes = {};
  for (const b of r.aggregations.by_code.buckets) codes[b.key] = b.doc_count;

  console.log(`\nAccess-log cross-check: ${LABEL} [${IFACE}]`);
  console.log(
    `  window  ${CLIENT.started_at} .. ${CLIENT.ended_at} (+${LAG_MS / 1000}s Filebeat lag margin)`
  );
  console.log(`  client  sent ${CLIENT.requests_sent}, replica counts ${JSON.stringify(CLIENT.replica_counts)}`);
  console.log(`           share ${JSON.stringify(shares(CLIENT.replica_counts))}`);
  console.log(`  envoy   ${total} access-log events, by replica ${JSON.stringify(envoy)}`);
  console.log(`           share ${JSON.stringify(shares(envoy))}`);
  console.log(`  envoy   by upstream_host ${JSON.stringify(upstream)}`);
  console.log(`  envoy   by response_code ${JSON.stringify(codes)}`);

  const out = {
    label: LABEL,
    interface: IFACE,
    window: { from: CLIENT.started_at, to: CLIENT.ended_at },
    client: { sent: CLIENT.requests_sent, replica_counts: CLIENT.replica_counts, share_pct: shares(CLIENT.replica_counts) },
    envoy: { total, by_replica: envoy, share_pct: shares(envoy), by_upstream_host: upstream, by_response_code: codes },
  };
  const dest = path.join(ROOT, "results", `${LABEL}-${IFACE}-accesslog.json`);
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(`  wrote ${path.relative(ROOT, dest)}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
