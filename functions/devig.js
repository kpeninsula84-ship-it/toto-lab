// De-vigging utilities — convert raw bookmaker odds into fair probabilities
// by removing the bookmaker's overround. Used to benchmark model probabilities
// against a sharp book (Pinnacle) on equal footing.
//
// References:
//   Joseph Buchdahl — "Squares & Sharps", Ch. 5 on overround removal
//   Štrumbelj 2014 — Shin and power methods for football betting markets

export function impliedProbs(odds) {
  return odds.map((o) => 1 / o);
}

export function bookSum(odds) {
  return impliedProbs(odds).reduce((a, b) => a + b, 0);
}

export function overround(odds) {
  return bookSum(odds) - 1;
}

// Proportional / multiplicative de-vig. Simple but biased toward favourites.
export function devigProportional(odds) {
  const probs = impliedProbs(odds);
  const total = probs.reduce((a, b) => a + b, 0);
  return probs.map((p) => p / total);
}

// Power method — find k such that sum(p_i^k) = 1.
// Less favourite-biased than proportional, recommended for football 1X2.
export function devigPower(odds, { tol = 1e-9, maxIter = 80 } = {}) {
  if (!Array.isArray(odds) || odds.length < 2) {
    throw new Error("devigPower needs at least 2 odds");
  }
  if (odds.some((o) => !Number.isFinite(o) || o <= 1)) {
    throw new Error("devigPower: odds must be > 1");
  }
  const probs = impliedProbs(odds);
  // Search k in [0.5, 2.0]: when k=1 sum(p)=overround, k>1 shrinks the
  // larger probabilities more quickly so sum decreases monotonically in k
  // for the cases we care about (overround > 0).
  let lo = 0.5;
  let hi = 2.0;
  const sumAt = (k) => probs.reduce((acc, p) => acc + Math.pow(p, k), 0);
  let s_lo = sumAt(lo);
  let s_hi = sumAt(hi);
  // Guard: expand search if both ends sit on the same side of 1.
  let guard = 0;
  while (s_lo < 1 && guard < 10) { lo /= 2; s_lo = sumAt(lo); guard++; }
  guard = 0;
  while (s_hi > 1 && guard < 10) { hi *= 2; s_hi = sumAt(hi); guard++; }
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const s_mid = sumAt(mid);
    if (Math.abs(s_mid - 1) < tol) {
      lo = hi = mid;
      break;
    }
    if (s_mid > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  return probs.map((p) => Math.pow(p, k));
}

// Shin (1993) — assumes a fraction z of insider trading. Solves
// p_i = (sqrt(z^2 + 4(1-z) * pi_i^2 / Z) - z) / (2(1-z)) where Z = bookSum.
// Particularly suited to two-way markets but works for 1X2 too.
export function devigShin(odds, { tol = 1e-9, maxIter = 60 } = {}) {
  if (!Array.isArray(odds) || odds.length < 2) {
    throw new Error("devigShin needs at least 2 odds");
  }
  const pi = impliedProbs(odds);
  const Z = pi.reduce((a, b) => a + b, 0);
  // Bisect z in [0, 1) such that sum of fair probabilities = 1.
  const fairSum = (z) => {
    let s = 0;
    for (const p of pi) {
      const val = Math.sqrt(z * z + 4 * (1 - z) * (p * p) / Z);
      s += (val - z) / (2 * (1 - z));
    }
    return s;
  };
  let lo = 0;
  let hi = 0.5;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const s = fairSum(mid);
    if (Math.abs(s - 1) < tol) {
      lo = hi = mid;
      break;
    }
    if (s > 1) lo = mid;
    else hi = mid;
  }
  const z = (lo + hi) / 2;
  return pi.map((p) => {
    const val = Math.sqrt(z * z + 4 * (1 - z) * (p * p) / Z);
    return (val - z) / (2 * (1 - z));
  });
}

// Convenience: remove vig from a 1X2 odds object {home, draw, away} and
// return the same shape with fair probabilities (sum = 1).
export function devigMatchWinner(matchWinner, method = "power") {
  const { home, draw, away } = matchWinner;
  if (!home || !draw || !away) return null;
  const fn = method === "shin" ? devigShin : method === "proportional" ? devigProportional : devigPower;
  const [pH, pD, pA] = fn([home, draw, away]);
  return { home: pH, draw: pD, away: pA };
}

// Two-way de-vig (over/under, AH home/away, team totals over/under).
export function devigTwoWay(side1Odds, side2Odds, method = "power") {
  if (!side1Odds || !side2Odds) return null;
  const fn = method === "shin" ? devigShin : method === "proportional" ? devigProportional : devigPower;
  const [p1, p2] = fn([side1Odds, side2Odds]);
  return [p1, p2];
}
