# Secret Identity — Assignments 1–3

DC character guessing game from Assignment 1, plus an OpenAPI spec, safe retries, a small rate limiter, a Python HTTP caller with timeout / backoff / circuit breaker, a gRPC service, and HTTP vs gRPC Grafana panels (Assignment 2). In Assignment 3 the same app runs as **three replicas (A / B / C) behind Envoy**, with per-replica HTTP and gRPC dashboards, Envoy + replica JSON logs shipped to Elasticsearch and searched in Kibana, and a set of load-balancing experiments (round robin, weighted, least-request, failure/recovery with active health checks).

See `REPORT_3.pdf` for the Assignment 3 write-up (source: `REPORT_3.md`).

## What you need

- Docker Compose v2
- Python 3.10+ for the callers and tests

```bash
pip install requests grpcio grpcio-tools
```

Node is only needed if you run the app outside Docker.

## Start

```bash
docker compose up -d --build
```

| Service | URL |
| --- | --- |
| Game | http://localhost:8000 |
| Swagger | http://localhost:8000/api/docs |
| OpenAPI file | http://localhost:8000/openapi.yaml |
| gRPC | `localhost:50051` |
| gRPC metrics | http://localhost:9091/metrics |
| Prometheus | http://localhost:9090/targets |
| Grafana | http://localhost:3000 (`admin` / `admin`) |
| **Game through Envoy (HTTP)** | http://localhost:10000 |
| **gRPC through Envoy** | `localhost:10001` |
| **Envoy admin / stats** | http://localhost:9901/stats |
| **Kibana** | http://localhost:5601 |
| **Elasticsearch** | http://localhost:9200 |

Comparison dashboard: **Secret Identity — HTTP vs gRPC**.
Assignment 3 dashboard: **Secret Identity — Load Balancing (A/B/C + Envoy)**.

## Generate gRPC stubs (if you edit `proto/game.proto`)

```bash
python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. proto/game.proto
```

## Tests and demos

```bash
py scripts/test_http_api.py      # valid, invalid, repeated (idempotent) HTTP calls
py scripts/test_rate_limit.py    # 5/10s window, then 429 + Retry-After
py scripts/http_caller.py        # timeout 1s, 3 retries, breaker 3 failures / 3s recovery
py scripts/grpc_caller.py 5      # success + expected RPC errors for Grafana
```

(`python` instead of `py` is fine if that is what your PATH uses.)

Optional background traffic (not required):

```bash
node scripts/load.js --duration 60 --players 2
```

Rebuild the report PDF after editing `REPORT_3.md`:

```bash
py scripts/md2pdf.py REPORT_3.md
```

## Assignment 3 — Load balancing and observability

The same `docker compose up -d --build` starts the whole A3 stack: three replicas
(`app-a`, `app-b`, `app-c`), Envoy, Prometheus, Grafana, Elasticsearch, Filebeat,
Kibana and node-exporter. Prometheus scrapes each replica **directly** and Envoy's
own admin port; clients go through Envoy on `:10000` (HTTP) and `:10001` (gRPC).

### Envoy policies

`envoy/envoy.yaml` is generated from `envoy/envoy.template.yaml` — do not edit it by
hand. Render and apply a policy in one step:

```bash
node scripts/envoy-policy.js list
node scripts/envoy-policy.js part-a       --apply   # Part A: only replica A
node scripts/envoy-policy.js part-c       --apply   # Part C: A+B+C, round robin
node scripts/envoy-policy.js weighted     --apply   # Part D: 2:1:1 weighted round robin
node scripts/envoy-policy.js least-request --apply  # Part D: least-request
node scripts/envoy-policy.js healthchecks --apply   # Part D: round robin + active health checks
```

> `healthchecks` renders **STATIC** endpoints (container IPs pinned at render time).
> Re-apply it right before the failure experiment if any replica was recreated, so
> the pinned IPs are current.

### Fixed-rate load generators

Both send on a fixed schedule and **do not wait** for a response; no retries, no
circuit breaker.

```bash
node scripts/loadgen.js      --rate 40 --duration 60 --label my-http --out results/my-http.json
node scripts/loadgen-grpc.js --rate 40 --duration 60 --label my-grpc --out results/my-grpc.json
```

### One full experiment (policy + optional delay + HTTP + gRPC + metrics)

```bash
node scripts/run-experiment.js --label part-c --policy part-c --http-rate 40 --grpc-rate 40 --duration 45
node scripts/run-experiment.js --label weighted --policy weighted --http-rate 40 --grpc-rate 40 --duration 45
node scripts/run-experiment.js --label least-request-delay --policy least-request \
  --delay-replica b --delay-every 1 --delay-ms 100 --http-rate 30 --grpc-rate 30 --duration 45
```

Client summaries land in `results/<label>-{http,grpc}.json`; Prometheus per-replica
snapshots in `results/<label>-{http,grpc}-metrics.json`.

### Failure and recovery (active health checks)

```bash
node scripts/experiment-healthcheck.js
# knobs: RATE, TOTAL_S, STOP_AT, RESTART_AT, LABEL, POLICY, NO_APPLY
```

Stops replica B, watches Envoy eject it after 3 failed checks, restarts it, and
watches it re-join after 2 successes. Writes `results/healthcheck-timeline.json`.

### Verify a distribution against Envoy's own access logs

```bash
node scripts/access-log-check.js --label weighted --interface http
node scripts/access-log-check.js --label weighted --interface grpc
```

Compares the client's per-replica counts with the replica Envoy recorded in its
access log for the same window (widened by a 30s Filebeat lag margin; change with
`--lag`).

### Trace correlation (Elasticsearch / Kibana)

```bash
node scripts/trace-search.js --sample --interface grpc
node scripts/trace-search.js <trace-id>
```

Kibana Discover filter for the same request: `trace_id: "<the id>"`.

### Manual chaos and recovery

```bash
node scripts/replica-chaos.js b --every 1 --ms 100   # 100 ms on every B request (HTTP + gRPC)
node scripts/replica-chaos.js b --clear
docker stop  secret-identity-app-b                   # simulate a replica failure
docker start secret-identity-app-b                   # recover
```

### Leave the stack in the documented default state

```bash
node scripts/envoy-policy.js part-c --apply
```

## Layout

```
app/                HTTP server, game engine, gRPC server + metrics, chaos module
proto/game.proto    schema; generated Python stubs sit next to it
openapi.yaml
envoy/              envoy.template.yaml + generated envoy.yaml (do not hand-edit)
scripts/            HTTP/gRPC callers, load generators, experiment + query tools
prometheus/         scrapes each replica (HTTP + gRPC) and Envoy directly
grafana/dashboards/ A1/A2 boards plus the A3 load-balancing board
filebeat/           Docker autodiscover -> Elasticsearch
results/            A3 experiment outputs (client summaries, metrics, timelines)
report-assets/      screenshots used in the report
REPORT_3.md         Assignment 3 write-up (source)
REPORT_3.pdf        Assignment 3 write-up (PDF, generated)
```

A3 scripts: `envoy-policy.js`, `loadgen.js`, `loadgen-grpc.js`, `collect-metrics.js`,
`replica-chaos.js`, `run-experiment.js`, `experiment-healthcheck.js`,
`access-log-check.js`, `trace-search.js`.

## Stop

```bash
docker compose down
```

`docker compose down -v` also drops volumes. Those data dirs are gitignored.

## Credit

Course labs (Midnight Launch / gRPC workshop), Nygard circuit breaker, RFC 6585 `429` + `Retry-After`.
