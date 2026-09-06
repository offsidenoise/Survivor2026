#!/usr/bin/env node
/*
 * fetch-powerindex.js — run by the scheduled GitHub Action, after
 * fetch-espn.js has written data/schedule.json.
 *
 * For every scheduled game across all 18 weeks, fetches ESPN's per-game
 * "power index" prediction — a model-based win probability derived from
 * team strength ratings, NOT a live betting/trading market. Unlike Kalshi
 * or a sportsbook line, this exists for every game the moment the schedule
 * is set, which is what makes it usable for weeks Kalshi hasn't opened a
 * market for yet.
 *
 * HONESTY FLAG: this specific endpoint (sports.core.api.espn.com .../
 * powerindex/{team}) is documented by the community but was NOT verified
 * live before this script was written — unlike the scoreboard/summary
 * endpoints, which were. Every fetch below is wrapped so ONE bad or
 * malformed game never kills the run; check this job's log for how many
 * games actually returned data before trusting the output.
 *
 * Output shape:
 *   {
 *     "updated": "2026-09-04T12:00:00Z",
 *     "verifiedThisRun": true/false,
 *     "gamesAttempted": 272,
 *     "gamesSucceeded": 0,
 *     "predictions": {
 *       "401671789": { "awayProb": 44.1, "homeProb": 55.9 }
 *     }
 *   }
 *
 * No dependencies — uses Node 18+ global fetch.
 */

const fs = require('fs');

const CORE_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events';

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Fetch both teams' power-index entries for one game. ESPN's powerindex
// resource is per-team, so we need the home and away team IDs from the
// schedule (not just abbreviations) — schedule.json doesn't carry ESPN's
// numeric team ID today, so this resolves it via the competitors list on
// the event itself first.
async function fetchGamePrediction(eventId) {
  // The event's own competition record lists competitor team refs with IDs.
  const compUrl = `${CORE_BASE}/${eventId}/competitions/${eventId}`;
  const comp = await getJSON(compUrl);
  const competitors = comp.competitors || [];

  const results = {};
  for (const c of competitors) {
    const teamId = c.id; // numeric ESPN team id for this competitor slot
    const homeAway = c.homeAway;
    const piUrl = `${CORE_BASE}/${eventId}/competitions/${eventId}/powerindex/${teamId}`;
    const pi = await getJSON(piUrl);
    // Field name for the win-probability stat varies across ESPN's power
    // index payloads in the wild; check a couple of plausible shapes.
    const stats = pi.stats || pi.statistics || [];
    const wp = stats.find(s => /winpercentage|predictedwinpct/i.test(s.name || s.type || ''));
    if (wp && wp.value != null) {
      results[homeAway] = Number(wp.value) * (wp.value <= 1 ? 100 : 1);
    }
  }
  if (results.home != null && results.away != null) return results;
  return null;
}

async function main() {
  let schedule;
  try {
    schedule = JSON.parse(fs.readFileSync('data/schedule.json', 'utf8'));
  } catch (e) {
    console.error('Could not read data/schedule.json — run fetch-espn.js first.');
    process.exit(1);
  }

  const games = [];
  for (const wk in schedule.weeks || {}) {
    for (const g of schedule.weeks[wk].games || []) games.push(g);
  }
  console.log('Attempting power-index for', games.length, 'games...');

  const predictions = {};
  let succeeded = 0;

  for (const g of games) {
    try {
      const result = await fetchGamePrediction(g.id);
      if (result) {
        predictions[g.id] = { awayProb: result.away, homeProb: result.home };
        succeeded++;
      }
    } catch (err) {
      // Expected for an unverified endpoint — log and move on, don't fail the run.
      console.warn('  game', g.id, 'powerindex failed:', err.message);
    }
    await new Promise(r => setTimeout(r, 150));
  }

  console.log(succeeded, '/', games.length, 'games returned a power-index prediction');

  const out = {
    updated: new Date().toISOString(),
    verifiedThisRun: succeeded > 0,
    gamesAttempted: games.length,
    gamesSucceeded: succeeded,
    predictions
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/powerindex.json', JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote data/powerindex.json');

  if (succeeded === 0) {
    console.warn('WARNING: zero games succeeded. The powerindex endpoint shape likely');
    console.warn('needs adjustment — check a single game manually before trusting recommend.js');
    console.warn('to lean on this data (it will fall back to ESPN moneyline automatically,');
    console.warn('but that fallback is weaker for far-future weeks — see README).');
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
