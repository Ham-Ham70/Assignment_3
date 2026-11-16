#!/usr/bin/env node
// Render envoy/envoy.yaml from envoy/envoy.template.yaml for a named policy,
// then optionally recreate the Envoy container so the change takes effect.
//
//   node scripts/envoy-policy.js list
//   node scripts/envoy-policy.js part-a
//   node scripts/envoy-policy.js part-c --apply
//   node scripts/envoy-policy.js weighted --apply
//
// Policies used by Assignment 3:
//   part-a         only replica A is in Envoy's destinations (Part A baseline)
//   part-c         A + B + C, equal weight, round robin (Part C baseline)
//   weighted       A + B + C with weights 2:1:1 (Part D)
//   least-request  A + B + C, least-request policy (Part D)
//   healthchecks   A + B + C, round robin, active health checks (Part D)

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TEMPLATE = path.join(ROOT, "envoy", "envoy.template.yaml");
const OUTPUT = path.join(ROOT, "envoy", "envoy.yaml");

const HTTP_PORT = 8000;
const GRPC_PORT = 50051;
const ADDRESS = { A: "app-a", B: "app-b", C: "app-c" };

// Each endpoint is ["A", weight]; a plain "A" means weight 1.
const POLICIES = {
  "part-a": {
    description: "Part A baseline: only replica A receives traffic",
    http: ["A"],
    grpc: ["A"],
    httpLb: "ROUND_ROBIN",
    grpcLb: "ROUND_ROBIN",
    healthChecks: false,
  },
  "part-c": {
    description: "Part C baseline: A+B+C, equal weight, round robin",
    http: ["A", "B", "C"],
    grpc: ["A", "B", "C"],
    httpLb: "ROUND_ROBIN",
    grpcLb: "ROUND_ROBIN",
    healthChecks: false,
  },
  weighted: {
    description: "Part D: weighted round robin 2:1:1 (A:B:C)",
    http: [["A", 2], ["B", 1], ["C", 1]],
    grpc: [["A", 2], ["B", 1], ["C", 1]],
    httpLb: "ROUND_ROBIN",
    grpcLb: "ROUND_ROBIN",
    healthChecks: false,
  },
  "least-request": {
    description: "Part D: least-request policy, equal weight",
    http: ["A", "B", "C"],
    grpc: ["A", "B", "C"],
    httpLb: "LEAST_REQUEST",
    grpcLb: "LEAST_REQUEST",
    healthChecks: false,
  },
  healthchecks: {
    description: "Part D: round robin + active health checks (failure/recovery)",
    http: ["A", "B", "C"],
    grpc: ["A", "B", "C"],
    httpLb: "ROUND_ROBIN",
    grpcLb: "ROUND_ROBIN",
    healthChecks: true,
    // STATIC endpoints (IPs resolved at render time) so the stopped replica
    // stays in the cluster and the active health check is what ejects it.
    // With STRICT_DNS, Docker DNS stops resolving the stopped container and
    // Envoy would drop the endpoint before the health check could act.
    staticEndpoints: true,
  },
};

function endpointsBlock(list, port, addressOf) {
  return list
    .map((entry) => {
      const [replica, weight] = Array.isArray(entry) ? entry : [entry, 1];
      const address = addressOf(replica);
      if (!address) throw new Error(`Unknown replica '${replica}'`);
      return [
        "              - endpoint:",
        "                  address:",
        "                    socket_address:",
        `                      address: ${address}`,
        `                      port_value: ${port}`,
        `                load_balancing_weight: ${weight}`,
      ].join("\n");
    })
    .join("\n");
}

// Resolve the current container IPs so a STATIC cluster can pin them.
function resolveReplicaIps() {
  const ips = {};
  for (const replica of Object.keys(ADDRESS)) {
    const container = `secret-identity-app-${replica.toLowerCase()}`;
    ips[replica] = execFileSync(
      "docker",
      ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container],
      { encoding: "utf8" }
    ).trim();
  }
  return ips;
}

// interval 2s / timeout 1s / unhealthy 3 / healthy 2:
// a stopped replica is removed after ~3 failures (~6s) and restored after
// 2 consecutive successes (~4s).
//
// no_traffic_interval MUST be set explicitly: Envoy defaults it to 60s, so
// without traffic a cluster is only probed once a minute and a failure would
// take a minute to notice. Setting it equal to `interval` keeps the probe
// cadence at 2s whether or not the cluster is carrying requests.
function healthChecksBlock(kind) {
  const probe =
    kind === "http"
      ? ["          http_health_check:", "            path: /api/health"]
      : ["          tcp_health_check: {}"];
  return [
    "      health_checks:",
    "        - timeout: 1s",
    "          interval: 2s",
    "          no_traffic_interval: 2s",
    "          unhealthy_interval: 2s",
    "          unhealthy_threshold: 3",
    "          healthy_threshold: 2",
    ...probe,
  ].join("\n");
}

function render(policyName) {
  const policy = POLICIES[policyName];
  if (!policy) {
    throw new Error(
      `Unknown policy '${policyName}'. Known: ${Object.keys(POLICIES).join(", ")}`
    );
  }
  const clusterType = policy.staticEndpoints ? "STATIC" : "STRICT_DNS";
  let addressOf = (replica) => ADDRESS[replica];
  if (policy.staticEndpoints) {
    const ips = resolveReplicaIps();
    addressOf = (replica) => ips[replica] || ADDRESS[replica];
  }
  const template = fs.readFileSync(TEMPLATE, "utf8");
  return template
    .replace("{{HTTP_CLUSTER_TYPE}}", clusterType)
    .replace("{{GRPC_CLUSTER_TYPE}}", clusterType)
    .replace("{{HTTP_LB_POLICY}}", policy.httpLb)
    .replace("{{GRPC_LB_POLICY}}", policy.grpcLb)
    .replace("{{HTTP_ENDPOINTS}}", endpointsBlock(policy.http, HTTP_PORT, addressOf))
    .replace("{{GRPC_ENDPOINTS}}", endpointsBlock(policy.grpc, GRPC_PORT, addressOf))
    .replace(
      "{{HTTP_HEALTH_CHECKS}}",
      policy.healthChecks ? healthChecksBlock("http") : ""
    )
    .replace(
      "{{GRPC_HEALTH_CHECKS}}",
      policy.healthChecks ? healthChecksBlock("grpc") : ""
    );
}

function apply() {
  console.log("Recreating envoy container ...");
  execFileSync("docker", ["compose", "up", "-d", "--force-recreate", "envoy"], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

function main() {
  const args = process.argv.slice(2);
  const name = args[0];
  const shouldApply = args.includes("--apply");

  if (!name || name === "list") {
    console.log("Policies:");
    for (const [key, p] of Object.entries(POLICIES)) {
      const http = p.http.map((e) => (Array.isArray(e) ? `${e[0]}=${e[1]}` : e)).join(",");
      const grpc = p.grpc.map((e) => (Array.isArray(e) ? `${e[0]}=${e[1]}` : e)).join(",");
      console.log(
        `  ${key.padEnd(15)} http[${p.httpLb}]={${http}}  grpc[${p.grpcLb}]={${grpc}}  health_checks=${p.healthChecks}`
      );
      console.log(`  ${" ".repeat(15)} ${p.description}`);
    }
    return;
  }

  const yaml = render(name);
  fs.writeFileSync(OUTPUT, yaml);
  console.log(`Rendered policy '${name}' -> envoy/envoy.yaml`);
  console.log(`  ${POLICIES[name].description}`);

  if (shouldApply) apply();
  else console.log("Run again with --apply to recreate the Envoy container.");
}

if (require.main === module) main();

module.exports = { POLICIES, render, OUTPUT };
