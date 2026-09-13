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
const yahooCrowd = readJSON('data/yahoo-crowd.json', { parseHealthy: false, picks: {} });
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

// Your pool size — used to scale Yahoo's national % into an estimated
// headcount for the EV simulation below. You told us 39.
const POOL_SIZE = 39;

// Yahoo only ever shows CURRENT week distribution — there's nothing to
// apply to future weeks, since nobody's picked them yet.
function yahooCrowdPctFor(wk, teamFullName) {
  if (Number(wk) !== (schedule.currentWeek || 1)) return null;
  if (!yahooCrowd.parseHealthy) return null;
  for (const nickname in yahooCrowd.picks) {
    if (teamFullName.includes(nickname)) return yahooCrowd.picks[nickname];
  }
  return null;
}

// --- Real expected-pool-share simulation (SurvivorGrid's published method,
// verified against their own worked FAQ example before being wired in here:
// a 10-person, 2-team case where their stated conclusion — the less-crowded
// team has HIGHER value despite a lower win probability — was reproduced
// exactly: EV 0.126 vs 0.086). NOT a fudge-factor penalty — this enumerates
// every possible combination of GAME results for the week (each game has
// exactly ONE winner — teams facing each other are never both "in play" as
// independent events, they're mutually exclusive outcomes of the same game),
// and for each combination weights "how many of your pool's estimated
// survivors would there be" against how likely that combination is. A
// team's value goes up when winning leaves you in a smaller, less-split
// group of survivors. ---
function computeWeekEV(games) {
  // games: [{ home, away, homeProb, awayProb, homePickCount, awayPickCount }]
  // — ONE entry per MATCHUP, not per team. Enforces exactly one winner per game.
  const n = games.length;
  if (n === 0 || n > 20) return {}; // 20 games = 1,048,576 outcomes, still fast; guard anyway
  const ev = {};
  games.forEach(g => { ev[g.home] = 0; ev[g.away] = 0; });

  const totalOutcomes = 1 << n; // 2^n
  for (let mask = 0; mask < totalOutcomes; mask++) {
    let jointProb = 1;
    let survivors = 0;
    for (let i = 0; i < n; i++) {
      const homeWins = !!(mask & (1 << i));
      jointProb *= homeWins ? games[i].homeProb : games[i].awayProb;
      survivors += homeWins ? games[i].homePickCount : games[i].awayPickCount;
    }
    if (survivors === 0 || jointProb === 0) continue;
    for (let i = 0; i < n; i++) {
      const homeWins = !!(mask & (1 << i));
      const winner = homeWins ? games[i].home : games[i].away;
      ev[winner] += jointProb / survivors;
    }
  }
  return ev;
}

for (const wk in schedule.weeks) {
  weekTeamProb[wk] = {};
  for (const g of schedule.weeks[wk].games || []) {
    const away = g.away.name, home = g.home.name;
    allTeamsSeen.add(away); allTeamsSeen.add(home);

    // COMPLETED GAME: the outcome is known, not a probability anymore. The
    // winner is a certain (100%) pick for this week; the loser is not a
    // viable choice for this week at all (you can't retroactively win a
    // game that's already over), so it gets no entry rather than a 0%
    // entry — 0% would produce -Infinity in the log-based scoring below.
    if (g.completed) {
      if (g.awayWinner) {
        weekTeamProb[wk][away] = { prob: 100, source: 'final-result', opponent: home };
      } else if (g.homeWinner) {
        weekTeamProb[wk][home] = { prob: 100, source: 'final-result', opponent: away };
      }
      // A tie leaves both out — neither actually "won" the week.
      continue;
    }

    const best = kalshiProbFor(away, home) || powerIndexProbFor(g.id) || espnMoneylineProbFor(g.espnOdds);
    if (!best) continue;

    weekTeamProb[wk][away] = { prob: best.away, source: best.source, opponent: home, crowdPct: yahooCrowdPctFor(wk, away) };
    weekTeamProb[wk][home] = { prob: best.home, source: best.source, opponent: away, crowdPct: yahooCrowdPctFor(wk, home) };
  }
}

// --- Run the real EV simulation for the CURRENT week only (the only week
// with actual crowd data) and attach the result to each team's entry. Built
// per MATCHUP (not per team) so each game correctly has exactly one winner —
// see computeWeekEV's comment above for why that distinction matters. ---
const currentWeekKey = String(schedule.currentWeek || 1);
let evHealthy = false;
if (yahooCrowd.parseHealthy && schedule.weeks[currentWeekKey]) {
  const evInputGames = [];
  for (const g of schedule.weeks[currentWeekKey].games || []) {
    if (g.completed) continue; // already resolved, not part of the live decision
    const awayEntry = weekTeamProb[currentWeekKey][g.away.name];
    const homeEntry = weekTeamProb[currentWeekKey][g.home.name];
    if (!awayEntry || !homeEntry) continue;
    if (awayEntry.crowdPct == null || homeEntry.crowdPct == null) continue; // need both sides' pick % to include this matchup
    evInputGames.push({
      home: g.home.name, away: g.away.name,
      homeProb: homeEntry.prob / 100, awayProb: awayEntry.prob / 100,
      homePickCount: Math.round((homeEntry.crowdPct / 100) * POOL_SIZE),
      awayPickCount: Math.round((awayEntry.crowdPct / 100) * POOL_SIZE)
    });
  }
  if (evInputGames.length >= 1) {
    const evResults = computeWeekEV(evInputGames);
    for (const team in evResults) {
      if (weekTeamProb[currentWeekKey][team]) {
        weekTeamProb[currentWeekKey][team].ev = evResults[team];
      }
    }
    evHealthy = true;
    console.log('Computed real pool-EV across', evInputGames.length, 'matchups in week', currentWeekKey);
  } else {
    console.warn('No matchups had crowd data for both teams — EV simulation skipped.');
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

// --- Run the optimization, twice: plain win-probability, and crowd-adjusted
// (real pool-EV simulation for the current week, if the scrape succeeded) --

function runOptimization(useCrowd) {
  if (!remainingWeeks.length || !availableTeams.length) return null;

  const scoreMatrix = availableTeams.map(team =>
    remainingWeeks.map(wk => {
      const entry = weekTeamProb[wk] && weekTeamProb[wk][team];
      if (!entry || entry.prob == null || entry.prob <= 0) return null;
      // Use the real simulated EV when it's available for this specific
      // team/week (current week only, and only if the EV sim actually ran)
      // — otherwise fall back to plain win probability, exactly as if this
      // feature didn't exist. No penalty constant anywhere in this path.
      if (useCrowd && entry.ev != null && entry.ev > 0) {
        return Math.log(entry.ev);
      }
      return Math.log(entry.prob / 100);
    })
  );

  const assignment = hungarianMaxAssignment(scoreMatrix);

  const weekAssignments = {};
  assignment.forEach((weekIdx, teamIdx) => {
    if (weekIdx === -1) return;
    const wk = remainingWeeks[weekIdx];
    const team = availableTeams[teamIdx];
    const entry = weekTeamProb[wk] && weekTeamProb[wk][team];
    if (entry && entry.prob != null) {
      weekAssignments[wk] = { team, prob: entry.prob, source: entry.source, opponent: entry.opponent, crowdPct: entry.crowdPct, ev: entry.ev };
    }
  });

  const thisWeek = remainingWeeks[0];
  return {
    week: thisWeek,
    pick: weekAssignments[thisWeek] || null,
    fullSeasonPlan: weekAssignments
  };
}

const originalRecommendation = runOptimization(false);
const crowdAdjustedRecommendation = runOptimization(true);

// --- Write output --------------------------------------------------------

const out = {
  updated: new Date().toISOString(),
  usedTeamsConsidered: Array.from(usedTeams),
  remainingWeeks,
  powerIndexHealthy: !!powerIndex.verifiedThisRun,
  yahooCrowdHealthy: !!yahooCrowd.parseHealthy,
  evHealthy,
  originalRecommendation,
  crowdAdjustedRecommendation
};

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/recommendation.json', JSON.stringify(out, null, 2) + '\n');

if (originalRecommendation && originalRecommendation.pick) {
  console.log('Original (no crowd) pick for week', originalRecommendation.week, ':',
    originalRecommendation.pick.team, '(' + Math.round(originalRecommendation.pick.prob) + '%)');
}
if (crowdAdjustedRecommendation && crowdAdjustedRecommendation.pick) {
  console.log('Crowd-adjusted pick for week', crowdAdjustedRecommendation.week, ':',
    crowdAdjustedRecommendation.pick.team, '(' + Math.round(crowdAdjustedRecommendation.pick.prob) + '%)');
}
if (!originalRecommendation || !originalRecommendation.pick) {
  console.warn('No recommendation could be computed — check remainingWeeks/availableTeams/data availability.');
}
