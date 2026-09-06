#!/usr/bin/env node
/*
 * fetch-kalshi.js — run by the scheduled GitHub Action, same pattern as the
 * World Cup app's fetch-kalshi.js.
 *
 * Fetches Kalshi's NFL game-winner markets (series KXNFLGAME) directly
 * (GitHub's runners are server-side, so there is no CORS problem here).
 * Each NFL event on Kalshi has exactly two markets — one per team, e.g.
 *   KXNFLGAME-25SEP04DALPHI-DAL   ("Will the Cowboys win?")
 *   KXNFLGAME-25SEP04DALPHI-PHI   ("Will the Eagles win?")
 * The team code is just the suffix after the last hyphen — no need to split
 * a concatenated blob the way the World Cup advances markets required.
 *
 * We group both legs of an event, read each leg's Yes price as that team's
 * implied win probability, and renormalize the pair to sum to 100 (mirrors
 * buildFinalPair() in the World Cup script).
 *
 * Output shape:
 *   {
 *     "updated": "2026-09-04T12:00:00Z",
 *     "odds": {
 *       "DAL_PHI": { "teams": {"DAL": 41, "PHI": 59},
 *                    "eventTicker": "KXNFLGAME-25SEP04DALPHI" }
 *     },
 *     "unmapped": ["XYZ"]   // codes seen but not in CODE_TO_NAME — check these
 *   }
 *
 * No dependencies — uses Node 18+ global fetch.
 */

const fs = require('fs');

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const SERIES = 'KXNFLGAME';

// Kalshi 3-ish-letter team code -> canonical name. Kalshi's exact codes
// haven't been verified against every team yet — this is a best-effort table
// covering common NFL abbreviation conventions (ESPN-style and PFR-style)
// so both are recognized. Any code seen in the data but not listed here gets
// logged under "unmapped" instead of silently dropped or mis-mapped.
const CODE_TO_NAME = {
  ARI:'Cardinals', ATL:'Falcons', BAL:'Ravens', BUF:'Bills',
  CAR:'Panthers', CHI:'Bears', CIN:'Bengals', CLE:'Browns',
  DAL:'Cowboys', DEN:'Broncos', DET:'Lions',
  GB:'Packers', GNB:'Packers',
  HOU:'Texans', IND:'Colts',
  JAX:'Jaguars', JAC:'Jaguars',
  KC:'Chiefs', KAN:'Chiefs',
  LV:'Raiders', LVR:'Raiders', OAK:'Raiders',
  LAC:'Chargers', SD:'Chargers',
  LAR:'Rams', LA:'Rams', STL:'Rams',
  MIA:'Dolphins', MIN:'Vikings',
  NE:'Patriots', NWE:'Patriots',
  NO:'Saints', NOR:'Saints',
  NYG:'Giants', NYJ:'Jets',
  PHI:'Eagles', PIT:'Steelers',
  SEA:'Seahawks', SF:'49ers', SFO:'49ers',
  TB:'Buccaneers', TAM:'Buccaneers',
  TEN:'Titans', WAS:'Commanders', WSH:'Commanders'
};

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function yesPriceOf(m) {
  const yb = parseFloat(m.yes_bid_dollars), ya = parseFloat(m.yes_ask_dollars);
  let yes = (Number.isFinite(yb) && Number.isFinite(ya) && (yb > 0 || ya > 0))
    ? (yb + ya) / 2 : parseFloat(m.last_price_dollars);
  return (Number.isFinite(yes) && yes > 0) ? yes : null;
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('Kalshi HTTP ' + r.status + ' for ' + url);
  return r.json();
}

async function fetchSeriesMarkets(series, statusFilter) {
  const out = [];
  let cursor = '';
  for (let i = 0; i < 15; i++) {
    let url = `${BASE}/markets?series_ticker=${series}&limit=200`;
    if (statusFilter) url += `&status=${statusFilter}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const j = await getJSON(url);
    const ms = (j && j.markets) || [];
    out.push(...ms);
    cursor = (j && j.cursor) || '';
    if (!cursor || !ms.length) break;
  }
  return out;
}

async function main() {
  console.log('Fetching series', SERIES);
  const markets = await fetchSeriesMarkets(SERIES, 'open');
  console.log('Got', markets.length, 'open markets');

  // Group both legs by event_ticker
  const byEvent = {};
  const unmapped = new Set();

  for (const m of markets) {
    const eventTicker = m.event_ticker || '';
    const ticker = m.ticker || '';
    const lastDash = ticker.lastIndexOf('-');
    const code = lastDash >= 0 ? ticker.slice(lastDash + 1) : '';
    if (!code) continue;

    const name = CODE_TO_NAME[code.toUpperCase()];
    if (!name) { unmapped.add(code); continue; }

    const yes = yesPriceOf(m);
    if (yes == null) continue;

    if (!byEvent[eventTicker]) byEvent[eventTicker] = [];
    byEvent[eventTicker].push({ name, pct: clamp(Math.round(yes * 100), 1, 99) });
  }

  const odds = {};
  let n = 0;
  for (const eventTicker in byEvent) {
    const legs = byEvent[eventTicker];
    if (legs.length !== 2) {
      console.warn('  event', eventTicker, 'has', legs.length, 'legs (expected 2) — skipping');
      continue;
    }
    const [A, B] = legs;
    if (A.name === B.name) continue;
    const total = A.pct + B.pct;
    const aPct = clamp(Math.round(A.pct / total * 100), 1, 99);
    const teams = {};
    teams[A.name] = aPct;
    teams[B.name] = 100 - aPct;

    const key = [A.name, B.name].sort().join('_');
    odds[key] = { teams, eventTicker };
    n++;
  }

  if (unmapped.size) {
    console.warn('Unmapped team codes seen:', Array.from(unmapped).join(', '));
    console.warn('Add these to CODE_TO_NAME in scripts/fetch-kalshi.js if they are real NFL teams.');
  }

  if (n === 0) {
    console.error('No matchups parsed — leaving existing kalshi-odds.json untouched.');
    process.exit(1);
  }

  const out = {
    updated: new Date().toISOString(),
    odds,
    unmapped: Array.from(unmapped)
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/kalshi-odds.json', JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote data/kalshi-odds.json with', n, 'matchups');
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
