# NFL Week Odds

A static site that shows the current week's NFL schedule with a
market-implied favorite for each game, sourced from ESPN's schedule and
Kalshi's real-money prediction market.

## Architecture

This does **not** call ESPN or Kalshi live from the browser. Instead:

1. A scheduled GitHub Action (`.github/workflows/fetch-odds.yml`) runs two
   Node scripts server-side, every 6 hours by default:
   - `scripts/fetch-espn.js` &rarr; fetches all 18 regular-season weeks,
     writes `data/schedule.json` keyed by week number, so the UI can flip
     between weeks (tabs, like the World Cup app's round tabs) without ever
     calling ESPN itself
   - `scripts/fetch-kalshi.js` &rarr; writes `data/kalshi-odds.json`
2. The Action commits those two JSON files back into the repo.
3. `app.js` fetches those same-origin files when the page loads and merges
   them — Kalshi's price is used when a matchup has one, ESPN's
   moneyline-derived probability is the fallback.

**Why this shape, and not a direct browser call:** running the fetch on
GitHub's servers avoids CORS entirely (server-to-server requests aren't
subject to it; browser-to-third-party ones are, and Kalshi's policy on that
wasn't something we could verify from a browser context). It also means the
page loads instantly and works even if Kalshi or ESPN are temporarily down —
it's just reading the last good data.

## Getting a daily pick recommendation

Two more scripts run in the same Action, right after the schedule/odds fetch:

- `scripts/fetch-powerindex.js` &rarr; writes `data/powerindex.json`. This
  pulls ESPN's per-game power-index prediction — a **model-based** win
  probability (from team strength ratings), not a live betting market. It
  exists for every scheduled game immediately, unlike Kalshi's markets,
  which only open close to kickoff. **Honesty flag:** this specific ESPN
  endpoint wasn't verified live before being wired in (unlike the
  scoreboard/summary ones). It's written to fail per-game rather than fail
  the whole run — check `data/powerindex.json`'s `gamesSucceeded` count
  after the first real run. If it's 0, the recommendation engine still
  works, just leaning more on ESPN's moneyline odds for far-future weeks
  instead.
- `scripts/recommend.js` &rarr; writes `data/recommendation.json`. This is
  the actual "AI"/optimization piece, and it's worth understanding what
  kind of AI it is: **not** an LLM guessing — it's a real optimization
  algorithm (Hungarian / linear assignment) that finds the team-to-week
  assignment across ALL remaining weeks that maximizes your probability of
  surviving the whole season, then reports what that assignment says to do
  this week. That's different from "pick whoever has the best number this
  week," which can burn a team you needed for a harder week later — the
  exact failure mode this was built to avoid.

Per-game probability is sourced in this priority order: **Kalshi** (real
trading, most accurate near kickoff) &rarr; **ESPN power index** (model-based,
covers future weeks Kalshi hasn't reached) &rarr; **ESPN moneyline** (fallback
if power index has no data for that game).

### `data/used-teams.json` — you maintain this by hand

The daily job runs on GitHub's servers with no access to whatever's in your
browser, so it has no way to know which teams you've already burned unless
you tell it. The site's **Actuals** tab (see below) makes this a copy-paste
instead of hand-typing — pick your team from a dropdown each week, then copy
the generated JSON into this file on GitHub (open it, tap the pencil icon,
paste, commit directly to `main`).

```json
{ "used": ["Eagles", "Chiefs"] }
```

Team names need to match how they appear in `schedule.json`'s
`away.name`/`home.name` fields (full display names like "Philadelphia
Eagles" — a substring match is used, so "Eagles" alone also works as long
as it's not ambiguous).

## The three tabs

- **Schedule** — the week-by-week matchup view from before.
- **Recommendation** — the current week's optimal pick from
  `data/recommendation.json`, plus the full remaining-season plan the
  optimizer is holding in reserve (subject to change as odds update).
- **Actuals** — a dropdown per week to record which team you actually
  picked. **This is saved to this browser's `localStorage`, not the repo** —
  there's no backend here for it to write to, and putting write credentials
  in client-side JS would expose them to anyone who views the page source.
  Once you've filled in a week, a "Copy JSON" box appears with exactly what
  to paste into `data/used-teams.json` on GitHub. Because it's
  localStorage, picks made on your phone won't show up if you open the site
  on a laptop — the source of truth is always `used-teams.json` in the repo,
  this tab is just a convenience for building it.

## Why Kalshi over a sportsbook line

Kalshi is a CFTC-regulated exchange for event contracts, not a licensed
sportsbook. Its "Yes" price on a team winning is what traders are actually
paying for that outcome — a real market price, not a bookmaker's posted line
(which has its own margin baked in). `fetch-kalshi.js` reads that price
directly per team and renormalizes the pair to sum to 100%.

## Known limitations

- **ESPN's endpoint is unofficial and unauthenticated** — the same one
  espn.com's own frontend uses, not a documented/supported public API. It
  can change shape without notice.
- **The power-index endpoint specifically is unverified** (see above) —
  written defensively, but confirm `gamesSucceeded > 0` in
  `data/powerindex.json` before trusting far-future-week recommendations.
- **Team code mapping for Kalshi** (`CODE_TO_NAME` in `fetch-kalshi.js`) is a
  best-effort table, not verified against Kalshi's actual ticker codes for
  all 32 teams yet. The script logs any code it can't map under
  `unmapped` in `data/kalshi-odds.json` and in the Action's run log — check
  there first if a game is missing its Kalshi price.
- **Matching Kalshi's team names to ESPN's** is done by substring match
  (e.g. "Cowboys" found inside "Dallas Cowboys"). This is usually reliable
  but could mismatch on an edge case; a game showing "ESPN moneyline" as its
  source instead of "Kalshi" is worth a manual check the first few weeks.
- If the Action hasn't run yet (fresh clone), the page will say so rather
  than fail silently — `data/*.json` ship as placeholders with `updated:
  null`.

## Running it locally

```
python3 -m http.server 8000
```
then visit `http://localhost:8000`. You'll see whatever's currently
committed in `data/` — to get fresh data locally, run:
```
node scripts/fetch-espn.js
node scripts/fetch-kalshi.js
```

## Deploying to GitHub Pages

1. Push this repo to GitHub:
   ```
   git remote add origin <your-repo-url>
   git branch -M main
   git push -u origin main
   ```
2. **Settings &rarr; Actions &rarr; General &rarr; Workflow permissions** &mdash;
   set to "Read and write permissions" so the Action can commit the data
   files back.
3. **Settings &rarr; Pages &rarr; Source** &mdash; select the `main` branch,
   `/ (root)`, save.
4. **Actions tab** &rarr; run `Fetch NFL schedule + Kalshi odds` once
   manually ("Run workflow") so `data/*.json` are populated before you wait
   for the first scheduled run.
