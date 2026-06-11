// Closing-line snapshot — fired every 30 min during typical EPL kickoff
// hours by .github/workflows/closing.yml. For every match kicking off
// within the next WINDOW_MIN minutes it overwrites `closingOdds` on the
// match doc, so the LAST write before kickoff approximates the closing
// line. collectResults later compares the pick-time price against this
// to compute CLV — the only KPI with statistical power at ~20-40
// picks/season.
//
// Costs one The Odds API call per firing ONLY when a kickoff is inside
// the window; otherwise it exits after a single Firestore query.

import { Timestamp } from "firebase-admin/firestore";
import { db } from "./firestore.js";
import { getEPLOdds, findOddsForMatch } from "../functions/oddsApi.js";
import { computeFairProbs } from "./pipeline.js";

const WINDOW_MIN = 75;

export async function snapshotClosingOdds(label = "closing") {
  const now = Date.now();
  const snap = await db
    .collection("matches")
    .where("kickoff", ">", Timestamp.fromMillis(now))
    .where("kickoff", "<=", Timestamp.fromMillis(now + WINDOW_MIN * 60_000))
    .get();

  const targets = snap.docs.filter((d) =>
    ["SCHEDULED", "TIMED"].includes(d.data().status)
  );
  if (!targets.length) {
    console.log(`[${label}] no kickoffs within ${WINDOW_MIN}min — nothing to snapshot`);
    return;
  }

  const events = await getEPLOdds(); // single API call for all targets

  for (const doc of targets) {
    const m = doc.data();
    const odds = findOddsForMatch(events, m.home, m.away);
    if (!odds) {
      console.log(`[${label}] no odds event for ${m.home} vs ${m.away} — skipped`);
      continue;
    }
    const minutesToKickoff = Math.round((m.kickoff.toMillis() - now) / 60_000);
    await doc.ref.update({
      closingOdds: {
        capturedAt: Timestamp.now(),
        minutesToKickoff,
        bookmaker: odds.bookmaker ?? null,
        matchWinner: odds.matchWinner ?? null,
        overUnder: odds.overUnder ?? null,
        fair: computeFairProbs(odds),
      },
    });
    console.log(`[${label}] ${m.home} vs ${m.away} snapshot at T-${minutesToKickoff}min`);
  }
}
