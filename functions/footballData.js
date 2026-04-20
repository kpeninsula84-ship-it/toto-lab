const BASE_URL = "https://api.football-data.org/v4";
const PL_CODE = "PL";

async function apiCall(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { "X-Auth-Token": process.env.FOOTBALL_DATA_TOKEN },
  });

  const remaining = res.headers.get("X-Requests-Available-Minute");
  if (remaining && parseInt(remaining, 10) <= 1) {
    console.log("[football-data] rate limit near, sleeping 10s");
    await new Promise((r) => setTimeout(r, 10_000));
  }

  if (!res.ok) {
    throw new Error(`football-data.org ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function getUpcomingMatches({ dateFrom, dateTo }) {
  const data = await apiCall(
    `/competitions/${PL_CODE}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`
  );
  return data.matches || [];
}

export async function getTeamRecentMatches(teamId, limit = 10) {
  const data = await apiCall(
    `/teams/${teamId}/matches?limit=${limit}&status=FINISHED`
  );
  return (data.matches || []).map((m) => ({
    date: m.utcDate,
    competition: m.competition?.name,
    home: m.homeTeam.name,
    away: m.awayTeam.name,
    score: `${m.score.fullTime.home ?? "-"}-${m.score.fullTime.away ?? "-"}`,
    winner: m.score.winner, // HOME_TEAM / AWAY_TEAM / DRAW
  }));
}

export async function getTeamUpcomingFixtures(teamId, limit = 5) {
  const data = await apiCall(
    `/teams/${teamId}/matches?limit=${limit}&status=SCHEDULED,TIMED`
  );
  return (data.matches || []).map((m) => ({
    date: m.utcDate,
    competition: m.competition?.name,
    home: m.homeTeam.name,
    away: m.awayTeam.name,
  }));
}

export async function getHeadToHead(matchId, limit = 5) {
  const data = await apiCall(`/matches/${matchId}/head2head?limit=${limit}`);
  return (data.matches || []).map((m) => ({
    date: m.utcDate,
    competition: m.competition?.name,
    home: m.homeTeam.name,
    away: m.awayTeam.name,
    score: `${m.score.fullTime.home ?? "-"}-${m.score.fullTime.away ?? "-"}`,
    winner: m.score.winner,
  }));
}

export async function getFinishedMatches({ dateFrom, dateTo }) {
  const data = await apiCall(
    `/competitions/${PL_CODE}/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}`
  );
  return (data.matches || []).map((m) => ({
    fixtureId: m.id,
    utcDate: m.utcDate,
    home: m.homeTeam.name,
    away: m.awayTeam.name,
    score: {
      home: m.score.fullTime.home,
      away: m.score.fullTime.away,
    },
    winner: m.score.winner, // HOME_TEAM / AWAY_TEAM / DRAW
  }));
}

export async function getStandings() {
  const data = await apiCall(`/competitions/${PL_CODE}/standings`);
  const total = data.standings.find((s) => s.type === "TOTAL")?.table || [];
  return total.map((row) => ({
    pos: row.position,
    team: row.team.name,
    teamId: row.team.id,
    played: row.playedGames,
    points: row.points,
    won: row.won,
    drawn: row.draw,
    lost: row.lost,
    gf: row.goalsFor,
    ga: row.goalsAgainst,
    gd: row.goalDifference,
    form: row.form, // "W,D,L,W,W"
  }));
}
