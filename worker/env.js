// Shared .env loader for worker entrypoints (import for side effect).
// In CI the env vars come from Actions secrets and no .env file exists.

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
