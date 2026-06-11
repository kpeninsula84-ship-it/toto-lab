// GitHub Actions entrypoint for the closing-line snapshot
// (.github/workflows/closing.yml).

import "./env.js";

const { snapshotClosingOdds } = await import("./snapshotClosing.js");

try {
  await snapshotClosingOdds();
} catch (err) {
  console.error("FATAL:", err);
  process.exit(1);
}
