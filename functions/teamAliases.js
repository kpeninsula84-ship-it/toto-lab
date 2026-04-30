// Maps known team name variants → football-data.org canonical names.
// Add a new row whenever a data source uses a name that doesn't exactly match.
export const ALIASES = new Map([
  // Arsenal
  ["Arsenal", "Arsenal FC"],
  // Aston Villa
  ["Aston Villa", "Aston Villa FC"],
  // Bournemouth
  ["Bournemouth", "AFC Bournemouth"],
  // Brentford
  ["Brentford", "Brentford FC"],
  // Brighton
  ["Brighton", "Brighton & Hove Albion FC"],
  ["Brighton & Hove Albion", "Brighton & Hove Albion FC"],
  // Burnley
  ["Burnley", "Burnley FC"],
  // Chelsea
  ["Chelsea", "Chelsea FC"],
  // Crystal Palace
  ["Crystal Palace", "Crystal Palace FC"],
  // Everton
  ["Everton", "Everton FC"],
  // Fulham
  ["Fulham", "Fulham FC"],
  // Ipswich (promotion candidate)
  ["Ipswich", "Ipswich Town FC"],
  ["Ipswich Town", "Ipswich Town FC"],
  // Leeds
  ["Leeds", "Leeds United FC"],
  ["Leeds United", "Leeds United FC"],
  // Leicester
  ["Leicester", "Leicester City FC"],
  ["Leicester City", "Leicester City FC"],
  // Liverpool
  ["Liverpool", "Liverpool FC"],
  // Luton (promotion candidate)
  ["Luton", "Luton Town FC"],
  ["Luton Town", "Luton Town FC"],
  // Manchester City
  ["Man City", "Manchester City FC"],
  ["Manchester City", "Manchester City FC"],
  // Manchester United
  ["Man United", "Manchester United FC"],
  ["Man Utd", "Manchester United FC"],
  ["Manchester United", "Manchester United FC"],
  // Newcastle
  ["Newcastle", "Newcastle United FC"],
  ["Newcastle United", "Newcastle United FC"],
  // Nottingham Forest
  ["Nottingham Forest", "Nottingham Forest FC"],
  ["Nott'm Forest", "Nottingham Forest FC"],
  ["Notts Forest", "Nottingham Forest FC"],
  ["Forest", "Nottingham Forest FC"],
  // Southampton
  ["Southampton", "Southampton FC"],
  // Sunderland
  ["Sunderland", "Sunderland AFC"],
  // Tottenham
  ["Spurs", "Tottenham Hotspur FC"],
  ["Tottenham", "Tottenham Hotspur FC"],
  ["Tottenham Hotspur", "Tottenham Hotspur FC"],
  // West Ham
  ["West Ham", "West Ham United FC"],
  ["West Ham United", "West Ham United FC"],
  // Wolves
  ["Wolves", "Wolverhampton Wanderers FC"],
  ["Wolverhampton", "Wolverhampton Wanderers FC"],
  ["Wolverhampton Wanderers", "Wolverhampton Wanderers FC"],
]);

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

/**
 * Resolves an injury-payload team name to a football-data.org canonical name.
 * Resolution order:
 *   1. Exact match against standings
 *   2. ALIASES lookup → canonical → standings
 *   3. Case-insensitive exact match
 *   4. Fuzzy (Levenshtein ≤ 4)
 *
 * Returns { canonicalName, teamId, method } or null if unresolved.
 */
export function resolveTeamName(name, nameToId) {
  // 1. Exact
  if (nameToId.has(name))
    return { canonicalName: name, teamId: nameToId.get(name), method: "exact" };

  // 2. Alias
  const aliased = ALIASES.get(name);
  if (aliased && nameToId.has(aliased))
    return { canonicalName: aliased, teamId: nameToId.get(aliased), method: "alias" };

  // 3. Case-insensitive exact
  const lower = name.toLowerCase();
  for (const [canonical, id] of nameToId) {
    if (canonical.toLowerCase() === lower)
      return { canonicalName: canonical, teamId: id, method: "case-insensitive" };
  }

  // 4. Fuzzy fallback
  let best = null;
  let bestDist = Infinity;
  for (const [canonical, id] of nameToId) {
    const dist = levenshtein(lower, canonical.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = { canonicalName: canonical, teamId: id };
    }
  }
  if (best && bestDist <= 4)
    return { ...best, method: `fuzzy(d=${bestDist})` };

  return null;
}
