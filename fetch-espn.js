#!/usr/bin/env node
/*
 * fetch-espn.js — run by the scheduled GitHub Action.
 *
 * Fetches ALL 18 NFL regular-season weeks from ESPN's public (unofficial)
 * scoreboard endpoint and writes data/schedule.json, keyed by week number —
 * so the frontend can let you flip between weeks (like the World Cup app's
 * round tabs) without ever making a live call itself.
 *
 * Also does one extra no-params call to find which week ESPN currently
 * considers "now", so the UI can default to that tab.
 *
 * Output shape:
 *   {
 *     "updated": "2026-09-04T12:00:00Z",
 *     "season": 2026,
 *     "currentWeek": 1,
 *     "weeks": {
 *       "1": { "games": [ { ... same per-game shape as before ... } ] },
 *       "2": { "games": [ ... ] },
 *       ...
 *     }
 *   }
 *
 * No dependencies — uses Node 18+ global fetch.
 */

const fs = require('fs');

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const REGULAR_SEASON_WEEKS = 18;

function moneylineToProb(ml) {
  if (ml === null || ml === undefined || isNaN(ml)) return null;
  ml = Number(ml);
  if (ml < 0) return (-ml) / (-ml + 100) * 100;
  return 100 / (ml + 100) * 100;
}

function devig(a, b) {
  if (a == null || b == null) return [a, b];
  const sum = a + b;
  if (sum <= 0) return [a, b];
  return [a / sum * 100, b / sum * 100];
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('ESPN HTTP ' + r.status + ' for ' + url);
  return r.json();
}

function extractOdds(comp) {
  const odds = comp.odds && comp.odds[0];
  if (!odds) return null;
  const homeOdds = odds.homeTeamOdds;
  const awayOdds = odds.awayTeamOdds;
  let homeProb = homeOdds && homeOdds.moneyLine != null ? moneylineToProb(homeOdds.moneyLine) : null;
  let awayProb = awayOdds && awayOdds.moneyLine != null ? moneylineToProb(awayOdds.moneyLine) : null;
  if (homeProb != null && awayProb != null) {
    [homeProb, awayProb] = devig(homeProb, awayProb);
  }
  return {
    details: odds.details || null,
    overUnder: odds.overUnder || null,
    provider: (odds.provider && odds.provider.name) || null,
    homeProb, awayProb
  };
}

function parseGames(data) {
  const events = data.events || [];
  const games = [];
  for (const evt of events) {
    const comp = evt.competitions && evt.competitions[0];
    if (!comp) continue;
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');
    if (!home || !away) continue;

    games.push({
      id: evt.id,
      date: evt.date,
      shortName: evt.shortName || '',
      away: {
        code: away.team.abbreviation,
        name: away.team.displayName,
        logo: away.team.logo || ''
      },
      home: {
        code: home.team.abbreviation,
        name: home.team.displayName,
        logo: home.team.logo || ''
      },
      espnOdds: extractOdds(comp)
    });
  }
  return games;
}

async function main() {
  const year = new Date().getFullYear();

  console.log('Fetching current week marker...');
  const currentData = await getJSON(BASE);
  const currentWeek = currentData.week ? currentData.week.number : 1;
  console.log('ESPN says current week is', currentWeek);

  const weeks = {};
  let totalGames = 0;

  for (let wk = 1; wk <= REGULAR_SEASON_WEEKS; wk++) {
    const url = `${BASE}?dates=${year}&seasontype=2&week=${wk}`;
    console.log('Fetching week', wk, '...');
    try {
      const data = await getJSON(url);
      const games = parseGames(data);
      weeks[wk] = { games };
      totalGames += games.length;
      console.log('  week', wk, '->', games.length, 'games');
    } catch (err) {
      console.warn('  week', wk, 'failed:', err.message, '(leaving it out this run)');
    }
    // Be polite to the unofficial endpoint — small delay between calls.
    await new Promise(r => setTimeout(r, 250));
  }

  if (totalGames === 0) {
    console.error('No games parsed for any week — leaving existing schedule.json untouched.');
    process.exit(1);
  }

  const out = {
    updated: new Date().toISOString(),
    season: year,
    currentWeek,
    weeks
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/schedule.json', JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote data/schedule.json with', totalGames, 'games across', Object.keys(weeks).length, 'weeks');
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
