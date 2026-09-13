#!/usr/bin/env node
/*
 * fetch-yahoo-crowd.js — run by the scheduled GitHub Action.
 *
 * Fetches Yahoo's public Survival Football pick-distribution page — a real
 * page, not a login-gated one, showing the NATIONAL percentage of Yahoo
 * players picking each team for the CURRENT week only (Yahoo doesn't show
 * future weeks — nobody's picked them yet). This is genuinely different
 * data from your own 39-person pool, which you've said is fine to use as
 * a proxy since you have no way to see your own pool's picks.
 *
 * HONESTY FLAGS, both real and both worth checking after the first run:
 *   1. This is a public WEBPAGE, not a documented API. Unlike ESPN's
 *      scoreboard endpoint or Kalshi's public market API, Yahoo has not
 *      published this for programmatic use. It's genuinely public (no
 *      login, no paywall) but scraping it is still outside what the page
 *      was built for — different situation from the SurvivorGrid/
 *      RotoBaller data, which sits behind a login or subscription, but
 *      not risk-free the way ESPN/Kalshi are.
 *   2. The page may render its table via client-side JavaScript. A plain
 *      server-side fetch() (which is all this script does) might get a
 *      near-empty HTML shell instead of the populated table. This is
 *      UNVERIFIED — check gamesMatched in data/yahoo-crowd.json after the
 *      first real run before trusting this data at all.
 *
 * Every team-label match is logged individually so a partial/broken parse
 * is visible in the Action's log, not silently wrong.
 *
 * Output shape:
 *   {
 *     "updated": "2026-09-13T18:00:00Z",
 *     "parseHealthy": true,
 *     "teamsMatched": 32,
 *     "picks": { "Chargers": 30.84, "Lions": 20.84, ... }   // nickname keyed
 *   }
 */

const fs = require('fs');

const URL = 'https://football.fantasysports.yahoo.com/survival/pickdistribution/';

// Yahoo's page shows market/city labels (sometimes abbreviated for shared
// markets), not full team names. Mapped here to each team's nickname, which
// is guaranteed to be a substring of schedule.json's full team.name
// (e.g. "Detroit Lions".includes("Lions")) — same matching style already
// used for Kalshi's team codes.
const YAHOO_LABEL_TO_NICKNAME = {
  'LA Chargers': 'Chargers', 'Detroit': 'Lions', 'Jacksonville': 'Jaguars',
  'Tennessee': 'Titans', 'Las Vegas': 'Raiders', 'Chicago': 'Bears',
  'Seattle': 'Seahawks', 'Pittsburgh': 'Steelers', 'Philadelphia': 'Eagles',
  'LA Rams': 'Rams', 'Dallas': 'Cowboys', 'Cincinnati': 'Bengals',
  'Baltimore': 'Ravens', 'Buffalo': 'Bills', 'Denver': 'Broncos',
  'New England': 'Patriots', 'Kansas City': 'Chiefs', 'Green Bay': 'Packers',
  'San Francisco': '49ers', 'NY Jets': 'Jets', 'NY Giants': 'Giants',
  'Miami': 'Dolphins', 'Minnesota': 'Vikings', 'Tampa Bay': 'Buccaneers',
  'Houston': 'Texans', 'Cleveland': 'Browns', 'Carolina': 'Panthers',
  'New Orleans': 'Saints', 'Atlanta': 'Falcons', 'Arizona': 'Cardinals',
  'Washington': 'Commanders', 'Indianapolis': 'Colts'
};

async function main() {
  console.log('Fetching', URL);
  const res = await fetch(URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; survivor-app-fetch/1.0)' }
  });
  if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
  const html = await res.text();
  console.log('Got', html.length, 'chars of HTML');

  const picks = {};
  let matched = 0;
  const unmatched = [];

  for (const label in YAHOO_LABEL_TO_NICKNAME) {
    const nickname = YAHOO_LABEL_TO_NICKNAME[label];
    // Look for the label, then a percentage within a short window after it —
    // tolerant of whatever tags/whitespace sit between them in the real markup.
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped + '[\\s\\S]{0,300}?(\\d{1,2}(?:\\.\\d+)?)\\s*%');
    const m = html.match(re);
    if (m) {
      picks[nickname] = parseFloat(m[1]);
      matched++;
    } else {
      unmatched.push(label);
    }
  }

  console.log('Matched', matched, '/', Object.keys(YAHOO_LABEL_TO_NICKNAME).length, 'teams');
  if (unmatched.length) {
    console.warn('No match found for:', unmatched.join(', '));
  }

  const parseHealthy = matched >= 28; // allow a few misses, not a total failure
  if (!parseHealthy) {
    console.warn('WARNING: fewer than 28/32 teams matched. This likely means');
    console.warn('the page is JS-rendered and this plain fetch() only got an');
    console.warn('empty shell — see the HONESTY FLAGS comment at the top of');
    console.warn('this file. Writing the (probably unreliable) result anyway');
    console.warn('so you can inspect it, but parseHealthy=false should be');
    console.warn('checked by anything consuming this file.');
  }

  const out = {
    updated: new Date().toISOString(),
    parseHealthy,
    teamsMatched: matched,
    picks
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/yahoo-crowd.json', JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote data/yahoo-crowd.json');
}

main().catch(e => {
  console.error('FAILED (non-fatal to the rest of the pipeline):', e.message);
  // Don't process.exit(1) here — a broken/blocked scrape shouldn't take down
  // schedule/odds/recommendation, which don't depend on this file existing.
  const out = { updated: new Date().toISOString(), parseHealthy: false, teamsMatched: 0, picks: {}, error: e.message };
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/yahoo-crowd.json', JSON.stringify(out, null, 2) + '\n');
});
