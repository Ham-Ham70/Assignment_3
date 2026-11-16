#!/usr/bin/env node
// Inject (or clear) the in-memory chaos delay on ONE replica, by exec'ing the
// app container and calling its own /chaos/delay endpoint. The replicas share a
// container image but each holds its own in-memory chaos state, so a delay has
// to be set on the specific replica we want to slow down.
//
//   node scripts/replica-chaos.js b --every 1 --ms 100   # every request to B waits 100ms
//   node scripts/replica-chaos.js b --clear
//   node scripts/replica-chaos.js --status               # ask every replica
//
// Requires Docker Desktop and the compose project running.

const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

function containerFor(replica) {
  return `secret-identity-app-${String(replica).toLowerCase()}`;
}

function callInContainer(container, urlPath, method) {
  const js = `fetch("http://127.0.0.1:8000${urlPath}", { method: "${method}" }).then(r=>r.text()).then(t=>console.log(t)).catch(e=>{console.error(e.message);process.exit(1)})`;
  return execFileSync("docker", ["exec", container, "node", "-e", js], {
    encoding: "utf8",
  }).trim();
}

function main() {
  if (args.includes("--status")) {
    for (const r of ["a", "b", "c"]) {
      const out = callInContainer(containerFor(r), "/chaos/status", "GET");
      console.log(`${r.toUpperCase()}: ${out}`);
    }
    return;
  }

  const replica = args[0];
  if (!replica || replica.startsWith("--")) {
    console.log("Usage: node scripts/replica-chaos.js <a|b|c> --every N --ms M | --clear");
    process.exit(1);
  }

  const container = containerFor(replica);
  if (args.includes("--clear")) {
    const out = callInContainer(container, "/chaos/delay?every=0&ms=0", "POST");
    console.log(`${replica.toUpperCase()} cleared: ${out}`);
    return;
  }

  const every = Number(opt("--every", 1));
  const ms = Number(opt("--ms", 100));
  const out = callInContainer(container, `/chaos/delay?every=${every}&ms=${ms}`, "POST");
  console.log(`${replica.toUpperCase()} delay set (every=${every}, ms=${ms}): ${out}`);
}

main();
