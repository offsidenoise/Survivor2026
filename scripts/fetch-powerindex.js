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
