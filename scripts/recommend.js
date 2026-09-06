#!/usr/bin/env node
/*
 * recommend.js — run by the scheduled GitHub Action, after fetch-espn.js,
 * fetch-kalshi.js, and fetch-powerindex.js.
 *
 * This is the "holistic" piece: rather than just picking whichever team has
 * the best win probability THIS week, it solves the assignment problem for
 * every remaining week at once — which team should go to which future week
 * — to maximize the probability of surviving the whole season, then reports
 * what that optimal assignment says to do this week specifically.
 *
 * Per-game win probability, in priority order:
 *   1. Kalshi (data/kalshi-odds.json)      — real trading, most accurate
 *      close to kickoff, only exists for near-term games
 *   2. ESPN power index (data/powerindex.json) — model-based, exists for
 *      every remaining week, used to fill the gap Kalshi hasn't reached yet
 *   3. ESPN moneyline-derived (data/schedule.json espnOdds) — fallback if
 *      power index came back empty for a given game
 *   4. null (unknown) — team's probability for that week just isn't used
 *      in the optimization; excluded rather than guessed
 *
 * Requires data/used-teams.json — a small file YOU maintain (see README) so
 * the optimizer knows what's off-limits. If it doesn't exist yet, every
 * team is treated as available and a warning is logged.
 *
 * Algorithm: maximize sum of log(probability) across a one-to-one team-to-
 * week assignment (standard Hungarian / linear assignment, adapted for a
 * rectangular team-count > week-count matrix). Maximizing the SUM of logs
 * is equivalent to maximizing the PRODUCT of survival probabilities across
 * the season — i.e. maximizing the chance of surviving every remaining week,
 * not just this one.
 *
 * Output: data/recommendation.json
 */

const fs = require('fs');

function readJSON(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) { return fallback; }
}

// --- Load inputs ------------------------------------------------------

const schedule = readJSON('data/schedule.json', null);
if (!schedule || !schedule.weeks) {
  console.error('data/schedule.json missing or empty — run fetch-espn.js first.');
  process.exit(1);
}
const kalshi = readJSON('data/kalshi-odds.json', { odds: {} });
const powerIndex = readJSON('data/powerindex.json', { predictions: {} });
const usedTeamsFile = readJSON('data/used-teams.json', null);

if (!usedTeamsFile) {
  console.warn('data/used-teams.json not found — treating ALL teams as available.');
  console.warn('Create it (see README) so recommendations respect teams you already burned.');
}
const usedTeams = new Set((usedTeamsFile && usedTeamsFile.used) || []);

// --- Build the week x team probability matrix --------------------------

function kalshiProbFor(awayName, homeName) {
  for (const key in kalshi.odds) {
    const teams = kalshi.odds[key].teams;
    const names = Object.keys(teams);
    const mA = names.find(n => awayName.includes(n));
    const mH = names.find(n => homeName.includes(n));
    if (mA && mH) return { away: teams[mA], home: teams[mH], source: 'kalshi' };
  }
  return null;
}

function powerIndexProbFor(gameId) {
  const p = powerIndex.predictions && powerIndex.predictions[gameId];
  if (p && p.awayProb != null && p.homeProb != null) {
    return { away: p.awayProb, home: p.homeProb, source: 'powerindex' };
  }
  return null;
}

function espnMoneylineProbFor(espnOdds) {
  if (espnOdds && espnOdds.awayProb != null && espnOdds.homeProb != null) {
    return { away: espnOdds.awayProb, home: espnOdds.homeProb, source: 'espn-moneyline' };
  }
  return null;
}

// weekTeamProb[week][teamName] = { prob, source, opponent }
const weekTeamProb = {};
const allTeamsSeen = new Set();

for (const wk in schedule.weeks) {
  weekTeamProb[wk] = {};
  for (const g of schedule.weeks[wk].games || []) {
    const away = g.away.name, home = g.home.name;
    allTeamsSeen.add(away); allTeamsSeen.add(home);

    const best = kalshiProbFor(away, home) || powerIndexProbFor(g.id) || espnMoneylineProbFor(g.espnOdds);
    if (!best) continue;

    weekTeamProb[wk][away] = { prob: best.away, source: best.source, opponent: home };
    weekTeamProb[wk][home] = { prob: best.home, source: best.source, opponent: away };
  }
}

// --- Determine remaining weeks (skip weeks with no unresolved games) ---
// A week is "remaining" if it's in the schedule and not already fully in
// the past relative to other weeks' data — simplest reliable signal here is
// "has at least one team with a probability entry", since past weeks won't
// have been re-fetched with fresh odds. If you want to hard-pin the current
// week, set schedule.currentWeek (fetch-espn.js already writes this).
const remainingWeeks = Object.keys(weekTeamProb)
  .map(Number)
  .filter(wk => wk >= (schedule.currentWeek || 1))
  .sort((a, b) => a - b);

const availableTeams = Array.from(allTeamsSeen).filter(t => !usedTeams.has(t));

// --- Hungarian algorithm (maximize sum of log-prob), rectangular-safe --
// Teams (rows) >= weeks (columns) is the expected case (32 teams, <=18
// weeks left). Pads the cost matrix to square with a large cost for
// "unassigned" so every week gets a team, not every team gets a week.
function hungarianMaxAssignment(scoreMatrix) {
  const nRows = scoreMatrix.length;
  const nCols = nRows ? scoreMatrix[0].length : 0;
  const n = Math.max(nRows, nCols);

  // Convert to a minimization cost matrix (negate), pad to square.
  const NEG_INF_COST = 1e6;
  const cost = [];
  for (let i = 0; i < n; i++) {
    cost.push([]);
    for (let j = 0; j < n; j++) {
      if (i < nRows && j < nCols) {
        const s = scoreMatrix[i][j];
        cost[i].push(s === null ? NEG_INF_COST : -s);
      } else {
        cost[i].push(0); // padding — free to assign, since it represents "no team"/"no week"
      }
    }
  }

  // Standard O(n^3) Hungarian algorithm (Jonker-Volgenant style, simplified).
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else { minv[j] -= delta; }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const rowToCol = new Array(nRows).fill(-1);
  for (let j = 1; j <= n; j++) {
    if (p[j] - 1 < nRows && j - 1 < nCols) rowToCol[p[j] - 1] = j - 1;
  }
  return rowToCol; // rowToCol[teamIndex] = weekIndex assigned, or -1
}

// --- Run the optimization ----------------------------------------------

let recommendation = null;

if (remainingWeeks.length && availableTeams.length) {
  const scoreMatrix = availableTeams.map(team =>
    remainingWeeks.map(wk => {
      const entry = weekTeamProb[wk] && weekTeamProb[wk][team];
      if (!entry || entry.prob == null || entry.prob <= 0) return null;
      return Math.log(entry.prob / 100);
    })
  );

  const assignment = hungarianMaxAssignment(scoreMatrix); // per team -> week index

  const weekAssignments = {}; // week -> { team, prob, source, opponent }
  assignment.forEach((weekIdx, teamIdx) => {
    if (weekIdx === -1) return;
    const wk = remainingWeeks[weekIdx];
    const team = availableTeams[teamIdx];
    const entry = weekTeamProb[wk] && weekTeamProb[wk][team];
    if (entry && entry.prob != null) {
      weekAssignments[wk] = { team, prob: entry.prob, source: entry.source, opponent: entry.opponent };
    }
  });

  const thisWeek = remainingWeeks[0];
  recommendation = {
    week: thisWeek,
    pick: weekAssignments[thisWeek] || null,
    fullSeasonPlan: weekAssignments
  };
}

// --- Write output --------------------------------------------------------

const out = {
  updated: new Date().toISOString(),
  usedTeamsConsidered: Array.from(usedTeams),
  remainingWeeks,
  powerIndexHealthy: !!powerIndex.verifiedThisRun,
  recommendation
};

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/recommendation.json', JSON.stringify(out, null, 2) + '\n');

if (recommendation && recommendation.pick) {
  console.log('Recommended pick for week', recommendation.week, ':', recommendation.pick.team,
    '(' + Math.round(recommendation.pick.prob) + '%, source:', recommendation.pick.source + ')');
} else {
  console.warn('No recommendation could be computed — check remainingWeeks/availableTeams/data availability.');
}
