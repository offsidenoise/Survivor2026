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
 * STATUS: verified live against a real ESPN game (Sept 2026) — the endpoint
 * works and the win-probability field is confirmed named "gameprojection".
 * Every fetch below is still wrapped so one bad/malformed game can't kill
 * the whole run, but this is no longer flying blind the way it was before.
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

async function fetchGamePrediction(eventId) {
  const compUrl = `${CORE_BASE}/${eventId}/competitions/${eventId}`;
  const comp = await getJSON(compUrl);
  const competitors = comp.competitors || [];

  const results = {};
  for (const c of competitors) {
    const teamId = c.id;
    const homeAway = c.homeAway;
    const piUrl = `${CORE_BASE}/${eventId}/competitions/${eventId}/powerindex/${teamId}`;
    const pi = await getJSON(piUrl);
    const stats = pi.stats || pi.statistics || [];
    const wp = stats.find(s => s.name === 'gameprojection')
      || stats.find(s => /win prob/i.test(s.displayName || ''));
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
    console.warn('WARNING: zero games succeeded EVEN AFTER THE GAMEPROJECTION FIX.');
    console.warn('If you see this exact message, the fix truly did not take effect this time.');
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
