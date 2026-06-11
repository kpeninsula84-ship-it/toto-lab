// GitHub Actions cron entrypoint (.github/workflows/worker.yml).
// Re-analyzes every EPL match kicking off in the next 24 hours by calling
// the Claude Code CLI headlessly (subscription auth, no API spend).
//
// Fixture collection and result collection run in Cloud Functions.
//
// Usage:
//   node runOnce.js          # default 24h window
//   node runOnce.js 48       # override window (manual one-off)

import { readFileSync, existsSync } from "node:fs";

const ENV_CANDIDATES = [
  process.env.WORKER_ENV_PATH,
  new URL("./.env", import.meta.url).pathname,
].filter(Boolean);

for (const path of ENV_CANDIDATES) {
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  console.log(`[env] loaded from ${path}`);
  break;
}

// Accept any numeric arg as horizon override. Tolerant of legacy invocations
// like `runOnce.js full 48` — pick up the first integer found.
const hrsArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const horizonHours = hrsArg ? parseInt(hrsArg, 10) : 24;

const { runScheduledAnalysis } = await import("./pipeline.js");

try {
  await runScheduledAnalysis(horizonHours, "worker");
} catch (err) {
  console.error("FATAL:", err);
  process.exit(1);
}
