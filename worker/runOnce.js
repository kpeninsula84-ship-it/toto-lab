// Single-run entry point for the analysis worker.
//
// Usage:
//   node worker/runOnce.js fixtures      # collect next 7 days of fixtures
//   node worker/runOnce.js analyze [hrs] # analyze unanalyzed matches in window (default 48h)
//   node worker/runOnce.js results       # mark won/lost on finished matches
//   node worker/runOnce.js full [hrs]    # fixtures → analyze → results
//
// Loads env from /Users/dw/Projects/toto-lab/functions/.env if present.
// Designed to be invoked by macOS launchd (or NAS cron) at scheduled times.

import { readFileSync, existsSync } from "node:fs";

const ENV_CANDIDATES = [
  process.env.WORKER_ENV_PATH,
  "/Users/dw/Projects/toto-lab/functions/.env",
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

const cmd = process.argv[2];
const arg = process.argv[3];

async function main() {
  switch (cmd) {
    case "fixtures": {
      const { collectFixtures } = await import("./pipeline.js");
      await collectFixtures(7);
      break;
    }
    case "analyze": {
      const { runScheduledAnalysis } = await import("./pipeline.js");
      const hrs = parseInt(arg ?? "48", 10);
      await runScheduledAnalysis(hrs, "worker");
      break;
    }
    case "results": {
      const { collectResults } = await import("./pipeline.js");
      await collectResults();
      break;
    }
    case "full": {
      const hrs = parseInt(arg ?? "48", 10);
      const { collectFixtures, runScheduledAnalysis, collectResults } = await import("./pipeline.js");
      await collectFixtures(7);
      await runScheduledAnalysis(hrs, "worker");
      await collectResults();
      break;
    }
    default:
      console.error("Usage: node worker/runOnce.js <fixtures|analyze [hrs]|results|full [hrs]>");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
