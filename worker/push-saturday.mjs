// One-shot script: push the ai-debate Saturday analyses to Firestore.
//
// Reads worker/saturday-analysis.json (+ rerun overrides) and overwrites the
// matching match docs with the ai-debate results, then triggers
// computeAndSaveRecommendations() to refresh recommendations/current.
//
// This is the validation-step push. Once worker/runOnce.js is running on a
// schedule, this script is no longer needed.

import { readFileSync, existsSync } from "node:fs";
import { Timestamp } from "firebase-admin/firestore";

const ENV_PATH = "/Users/dw/Projects/toto-lab/functions/.env";
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const { db } = await import("./firestore.js");
const { computeAndSaveRecommendations } = await import("./pipeline.js");

const baseDir = new URL(".", import.meta.url).pathname;
const primary = JSON.parse(readFileSync(baseDir + "saturday-analysis.json", "utf8"));

// Apply re-run overrides on top (latest wins)
const reruns = ["saturday-analysis-rerun-2.json", "saturday-analysis-rerun-1.json"];
const overrides = new Map();
for (const file of reruns) {
  const path = baseDir + file;
  if (!existsSync(path)) continue;
  for (const r of JSON.parse(readFileSync(path, "utf8"))) {
    if (!r.error && r.fixtureId) overrides.set(r.fixtureId, r);
  }
}

const finalResults = primary.map((r) =>
  r.fixtureId && overrides.has(r.fixtureId) ? overrides.get(r.fixtureId) : r
);

console.log(`[push] applying ${finalResults.length} ai-debate analyses`);

let pushed = 0;
for (const r of finalResults) {
  if (r.error) {
    console.log(`  skip ${r.match} — error: ${r.error}`);
    continue;
  }
  const ref = db.collection("matches").doc(String(r.fixtureId));
  const update = {
    probs: r.probs,
    overUnder: r.overUnder,
    ouLine: r.ouLine,
    pick: r.pick === "none" ? null : r.pick,
    edge: r.edgeRaw, // legacy raw edge from Claude
    confidence: r.confidence,
    reasoning: r.reasoning,
    odds: r.odds || null,
    fairProbs: r.fairProbs || null,
    edgeFair: r.edgeFair,
    backend: "ai-debate",
    model: "claude-sonnet-4-6",
    analyzed: true,
    analyzedAt: Timestamp.now(),
    injuriesSnapshot: r.injuries || null,
  };
  await ref.set(update, { merge: true });
  console.log(`  ✓ ${r.match} → pick=${update.pick} conf=${r.confidence} edgeFair=${r.edgeFair}`);
  pushed++;
}

console.log(`\n[push] ${pushed} matches updated`);
console.log("[push] recomputing recommendations/current...");
const payload = await computeAndSaveRecommendations();
console.log(`[push] recommendations: ${payload.pickCount} picks, ${payload.secondaryPicks.length} secondary, comboOdds=${payload.comboOdds}`);
console.log("\n=== picks pushed ===");
for (const p of payload.picks) {
  console.log(`  ${p.home} vs ${p.away} | ${p.pickLabel} @${p.odds} | edgeFair +${p.edge}%p | conf ${p.confidence}`);
}
process.exit(0);
