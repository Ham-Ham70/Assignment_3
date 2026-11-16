#!/usr/bin/env node
// Correlate one request across Envoy and the replica that served it.
//
//   node scripts/trace-search.js <trace-id>
//   node scripts/trace-search.js --sample        # newest trace with both sides
//   node scripts/trace-search.js --sample --interface grpc
//
// Queries Elasticsearch directly (same data Kibana Discover shows). A trace id
// is set by the load generators as X-Trace-ID and logged by Envoy (access log)
// and by the replica (HTTP or gRPC logger).

const args = process.argv.slice(2);
const ES = process.env.ES_URL || "http://localhost:9200";
const INDEX = process.env.ES_INDEX || "secret-identity-logs-*";

function flag(name) {
  return args.includes(name);
}
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

async function esSearch(body) {
  const res = await fetch(`${ES}/${INDEX}/_search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ES ${res.status}: ${await res.text()}`);
  return res.json();
}

function describe(src) {
  const when = src["@timestamp"] || src.envoy_start_time || "?";
  const service = src.log_source || src.container?.name || "?";
  const replica = src.replica || "-";
  const iface = src.api || (String(service).includes("grpc") ? "grpc" : "http");
  const status = src.status_code ?? src.response_code ?? src.grpc_code ?? "-";
  const duration = src.duration_ms ?? "-";
  const route = src.route || src.path || src.grpc_method || "-";
  return { when, service, replica, iface, status, duration, route, message: src.message };
}

async function printTrace(traceId) {
  const result = await esSearch({
    query: { term: { trace_id: traceId } },
    sort: [{ "@timestamp": "asc" }],
    size: 50,
  });
  const hits = result.hits.hits;
  console.log(`\nTrace ${traceId} — ${hits.length} event(s)`);
  if (!hits.length) {
    console.log("  (nothing found; is Filebeat shipping logs yet?)");
    return hits.length;
  }
  for (const h of hits) {
    const d = describe(h._source);
    console.log(
      `  ${d.when}  [${d.service.padEnd(22)}] iface=${d.iface.padEnd(4)} replica=${String(
        d.replica
      ).padEnd(2)} status=${String(d.status).padEnd(4)} ${String(d.duration).padStart(6)}ms  ${d.route}`
    );
    if (d.message) console.log(`      "${d.message}"`);
  }
  const envoy = hits.filter((h) => h._source.log_source === "envoy").length;
  const backend = hits.length - envoy;
  console.log(`  -> envoy events: ${envoy}, replica events: ${backend}`);
  return hits.length;
}

async function sample(interfaceFilter) {
  const must = [{ exists: { field: "trace_id" } }];
  const body = {
    query: { bool: { must } },
    sort: [{ "@timestamp": "desc" }],
    size: 200,
    _source: ["trace_id", "log_source", "api"],
  };
  const result = await esSearch(body);
  const byTrace = new Map();
  for (const h of result.hits.hits) {
    const s = h._source;
    if (!s.trace_id || s.trace_id === "-") continue;
    if (interfaceFilter && s.api && s.api !== interfaceFilter) continue;
    const rec = byTrace.get(s.trace_id) || { envoy: false, backend: false };
    if (s.log_source === "envoy") rec.envoy = true;
    else rec.backend = true;
    byTrace.set(s.trace_id, rec);
  }
  for (const [tid, rec] of byTrace) {
    if (rec.envoy && rec.backend) {
      await printTrace(tid);
      return tid;
    }
  }
  console.log("No trace found with both an Envoy event and a replica event yet.");
  return null;
}

async function dump(n = 4) {
  const service = opt("--log-source") || opt("--service");
  const exists = opt("--exists");
  const query = exists
    ? { exists: { field: exists } }
    : service
      ? { term: { log_source: service } }
      : { match_all: {} };
  const result = await esSearch({ query, sort: [{ "@timestamp": "desc" }], size: n });
  console.log(`${result.hits.total.value} matching docs; newest ${result.hits.hits.length}:`);
  for (const h of result.hits.hits) {
    console.log("\n--- " + h._index + " ---");
    const s = h._source;
    console.log(
      JSON.stringify(
        {
          "@timestamp": s["@timestamp"],
          log_source: s.log_source,
          api: s.api,
          replica: s.replica,
          trace_id: s.trace_id,
          request_id: s.request_id,
          method: s.method,
          path: s.path,
          route: s.route,
          grpc_method: s.grpc_method,
          status_code: s.status_code,
          response_code: s.response_code,
          grpc_code: s.grpc_code,
          duration_ms: s.duration_ms,
          upstream_host: s.upstream_host,
          message: s.message,
        },
        null,
        2
      )
    );
  }
}

async function main() {
  const positional = args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--interface");
  if (flag("--dump")) {
    await dump();
    return;
  }
  if (flag("--sample")) {
    await sample(opt("--interface"));
    return;
  }
  const traceId = positional[0];
  if (!traceId) {
    console.log("Usage: node scripts/trace-search.js <trace-id> | --sample [--interface http|grpc]");
    process.exit(1);
  }
  await printTrace(traceId);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
