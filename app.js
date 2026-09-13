// NFL Week Odds
// Reads pre-fetched, same-origin JSON files written by the scheduled
// GitHub Action — no live browser calls, no CORS risk:
//   data/schedule.json       — ESPN schedule for all 18 weeks + moneyline odds
//   data/kalshi-odds.json    — Kalshi's real-money market prices, when available
//   data/powerindex.json     — ESPN's model-based per-game win probability
//   data/recommendation.json — the server's last computed optimal plan
//     (used here only as a baseline for "teams already burned" — the actual
//     recommendation shown is recomputed live in the browser, see below)
//
// LIVE RECOMMENDATION: the Hungarian assignment algorithm from
// scripts/recommend.js is duplicated here (buildProbTable / hungarianMax
// Assignment) so the Recommendation tab can react instantly to picks made
// in the Actuals tab, without waiting for a round trip through GitHub.
// Server-side used-teams.json (via recommendation.json's usedTeamsConsidered)
// and this browser's local Actuals picks are merged as the exclusion set.
//
// The Actuals tab itself is still genuinely client-side only: there's no
// backend here, so "which team did I actually pick" can't write back into
// the repo's data/used-teams.json by itself. It saves to this browser's
// localStorage, and generates the JSON to paste in by hand — see the README.

const LOCAL_STORAGE_KEY = 'survivor-actual-picks';

const statusEl = document.getElementById('status');
const gamesEl = document.getElementById('games');
const sourceNoteEl = document.getElementById('source-note');
const tabsEl = document.getElementById('week-tabs');
const viewTabsEl = document.getElementById('view-tabs');

let scheduleData = null;
let kalshiData = null;
let powerIndexData = null;
let yahooCrowdData = null;
let serverRec = null;
let activeWeek = null;

function setStatus(text, isError){
  statusEl.style.display = 'block';
  statusEl.textContent = text;
  statusEl.classList.toggle('error', !!isError);
  gamesEl.innerHTML = '';
}
function clearStatus(){ statusEl.style.display = 'none'; }

async function getJSON(path){
  const res = await fetch(path, { cache: 'no-store' });
  if(!res.ok) throw new Error(path + ' failed to load (' + res.status + ')');
  return res.json();
}

function timeAgo(iso){
  if(!iso) return 'unknown';
  return new Date(iso).toLocaleString(undefined, {
    month:'short', day:'numeric', hour:'numeric', minute:'2-digit'
  });
}

// ---------- View switching ----------

viewTabsEl.querySelectorAll('.view-tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    viewTabsEl.querySelectorAll('.view-tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.view-panel').forEach(p=>p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('view-' + tab.dataset.view).classList.add('active');
    document.getElementById('week-tabs').style.display = tab.dataset.view === 'schedule' ? 'flex' : 'none';
    if(tab.dataset.view === 'recommendation') renderRecommendation();
    if(tab.dataset.view === 'crowd') renderCrowdInputs();
  });
});

// ---------- Shared: resolve a game's probability + source ----------
// Priority: Kalshi (real market) > ESPN power index (model projection,
// covers weeks Kalshi hasn't opened) > ESPN moneyline (fallback).

function kalshiEntryFor(awayName, homeName){
  if(!kalshiData) return null;
  for(const key in kalshiData.odds){
    const teams = kalshiData.odds[key].teams;
    const names = Object.keys(teams);
    const matchAway = names.find(n => awayName.includes(n));
    const matchHome = names.find(n => homeName.includes(n));
    if(matchAway && matchHome){
      return { awayProb: teams[matchAway], homeProb: teams[matchHome] };
    }
  }
  return null;
}

function powerIndexEntryFor(gameId){
  const p = powerIndexData && powerIndexData.predictions && powerIndexData.predictions[gameId];
  if(p && p.awayProb != null && p.homeProb != null){
    return { awayProb: p.awayProb, homeProb: p.homeProb };
  }
  return null;
}

// Returns { awayProb, homeProb, source, sourceLabel, updated, completed, awayScore, homeScore }
function resolveGameOdds(g){
  if(g.completed){
    return {
      completed: true,
      awayScore: g.awayScore, homeScore: g.homeScore,
      awayWinner: g.awayWinner, homeWinner: g.homeWinner,
      awayProb: g.awayWinner ? 100 : (g.homeWinner ? 0 : null),
      homeProb: g.homeWinner ? 100 : (g.awayWinner ? 0 : null),
      source: 'final-result', sourceLabel: 'Final',
      updated: scheduleData && scheduleData.updated
    };
  }
  const kalshi = kalshiEntryFor(g.away.name, g.home.name);
  if(kalshi){
    return { ...kalshi, source:'kalshi', sourceLabel:'Kalshi market',
      updated: kalshiData && kalshiData.updated };
  }
  const pi = powerIndexEntryFor(g.id);
  if(pi){
    return { ...pi, source:'powerindex', sourceLabel:'ESPN power index (projection)',
      updated: powerIndexData && powerIndexData.updated };
  }
  const espn = g.espnOdds;
  if(espn && espn.awayProb != null && espn.homeProb != null){
    return { awayProb: espn.awayProb, homeProb: espn.homeProb, source:'espn-moneyline',
      sourceLabel:'ESPN moneyline', updated: scheduleData && scheduleData.updated };
  }
  return null;
}

// ---------- Schedule view ----------

function renderTabs(){
  tabsEl.innerHTML = '';
  const weekNums = Object.keys(scheduleData.weeks).map(Number).sort((a,b)=>a-b);
  weekNums.forEach(wk=>{
    const btn = document.createElement('button');
    btn.className = 'week-tab' + (wk === activeWeek ? ' active' : '') +
      (wk === scheduleData.currentWeek ? ' current' : '');
    btn.textContent = 'Wk ' + wk;
    btn.addEventListener('click', ()=>{
      activeWeek = wk;
      renderTabs();
      renderWeek();
    });
    tabsEl.appendChild(btn);
  });
}

function renderWeek(){
  const week = scheduleData.weeks[activeWeek];
  const games = (week && week.games) || [];
  gamesEl.innerHTML = '';

  if(games.length === 0){
    setStatus('No games found for Week ' + activeWeek + '.');
    return;
  }
  clearStatus();

  games.forEach(g=>{
    const odds = resolveGameOdds(g);
    const awayProb = odds ? odds.awayProb : null;
    const homeProb = odds ? odds.homeProb : null;
    const homeFav = (awayProb != null && homeProb != null) ? homeProb > awayProb : null;
    const kickoff = g.date ? new Date(g.date).toLocaleString(undefined, {
      weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit'
    }) : '';

    // Score is shown as its own badge, separate from the probability text —
    // never bundled into one small line where it's easy to miss.
    const awayScoreBadge = (g.completed || g.inProgress) && g.awayScore != null
      ? `<span class="score-badge${g.awayWinner ? ' winner' : ''}">${g.awayScore}</span>` : '';
    const homeScoreBadge = (g.completed || g.inProgress) && g.homeScore != null
      ? `<span class="score-badge${g.homeWinner ? ' winner' : ''}">${g.homeScore}</span>` : '';

    // Probability text: same wording whether pregame or in-progress — Kalshi
    // trades continuously through the game (refreshed every 5 min), so a
    // "live" number here is genuinely current, not a stale pregame snapshot.
    // Only a truly completed game skips this in favor of the final checkmark.
    const awayLabel = g.completed
      ? (g.awayWinner ? '\u2713 Won' : '')
      : (awayProb != null ? Math.round(awayProb) + '% implied' : '');
    const homeLabel = g.completed
      ? (g.homeWinner ? '\u2713 Won' : '')
      : (homeProb != null ? Math.round(homeProb) + '% implied' : '');

    const card = document.createElement('div');
    card.className = 'game-card';
    card.innerHTML = `
      <div class="game-meta">
        <span>${g.shortName || ''}</span>
        <span>${g.completed ? 'FINAL' : g.inProgress ? '<span class="live-badge">\u25CF LIVE</span>' : kickoff}</span>
      </div>
      <div class="matchup">
        <div class="team ${homeFav === false ? 'favorite' : ''}">
          <img class="team-logo" src="${g.away.logo || ''}" alt="" onerror="this.style.display='none'">
          <div>
            <div class="team-name">${g.away.name} ${awayScoreBadge}</div>
            <div class="team-prob">${awayLabel}</div>
          </div>
        </div>
        <span class="vs">@</span>
        <div class="team ${homeFav === true ? 'favorite' : ''}">
          <img class="team-logo" src="${g.home.logo || ''}" alt="" onerror="this.style.display='none'">
          <div>
            <div class="team-name">${g.home.name} ${homeScoreBadge}</div>
            <div class="team-prob">${homeLabel}</div>
          </div>
        </div>
      </div>
      <div class="odds-line">
        ${g.completed
          ? 'Game complete \u2014 locked out of future recommendations for this week'
          : g.inProgress
            ? 'Live odds \u2014 Source: ' + (odds ? odds.sourceLabel : 'unavailable') + ' &middot; updated ' + (odds ? timeAgo(odds.updated) : '')
            : (odds ? 'Source: ' + odds.sourceLabel + ' &middot; updated ' + timeAgo(odds.updated) : 'No odds available yet for this game.')}
        ${!g.completed && g.espnOdds && g.espnOdds.details ? ' &middot; ' + g.espnOdds.details : ''}
        ${!g.completed && g.espnOdds && g.espnOdds.overUnder ? ' &middot; O/U ' + g.espnOdds.overUnder : ''}
      </div>
    `;
    gamesEl.appendChild(card);
  });

  sourceNoteEl.innerHTML =
    `Schedule fetched ${timeAgo(scheduleData.updated)} &middot; Kalshi ${timeAgo(kalshiData && kalshiData.updated)} ` +
    `&middot; ESPN power index ${timeAgo(powerIndexData && powerIndexData.updated)}. ` +
    `All refresh on a schedule via GitHub Actions, not on page load.`;
}

// ---------- Live recommendation engine (mirrors scripts/recommend.js) ----------

function hungarianMaxAssignment(scoreMatrix){
  const nRows = scoreMatrix.length;
  const nCols = nRows ? scoreMatrix[0].length : 0;
  const n = Math.max(nRows, nCols);
  if(n === 0) return [];

  const NEG_INF_COST = 1e6;
  const cost = [];
  for(let i=0;i<n;i++){
    cost.push([]);
    for(let j=0;j<n;j++){
      if(i < nRows && j < nCols){
        const s = scoreMatrix[i][j];
        cost[i].push(s === null ? NEG_INF_COST : -s);
      } else {
        cost[i].push(0);
      }
    }
  }

  const u = new Array(n+1).fill(0);
  const v = new Array(n+1).fill(0);
  const p = new Array(n+1).fill(0);
  const way = new Array(n+1).fill(0);

  for(let i=1;i<=n;i++){
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n+1).fill(Infinity);
    const used = new Array(n+1).fill(false);
    do{
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = -1;
      for(let j=1;j<=n;j++){
        if(!used[j]){
          const cur = cost[i0-1][j-1] - u[i0] - v[j];
          if(cur < minv[j]){ minv[j] = cur; way[j] = j0; }
          if(minv[j] < delta){ delta = minv[j]; j1 = j; }
        }
      }
      for(let j=0;j<=n;j++){
        if(used[j]){ u[p[j]] += delta; v[j] -= delta; }
        else { minv[j] -= delta; }
      }
      j0 = j1;
    } while(p[j0] !== 0);
    do{
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while(j0);
  }

  const rowToCol = new Array(nRows).fill(-1);
  for(let j=1;j<=n;j++){
    if(p[j]-1 < nRows && j-1 < nCols) rowToCol[p[j]-1] = j-1;
  }
  return rowToCol;
}

// ---------- Crowd % ----------
// Primary source: data/yahoo-crowd.json — auto-fetched server-side from
// Yahoo's public Survival Football pick-distribution page (national %,
// current week only, since Yahoo doesn't show future weeks). Falls back to
// manually-entered data (Crowd % tab, localStorage) for any team/week the
// auto-fetch didn't cover — e.g. if the scrape failed, or for a team Yahoo's
// page didn't match cleanly.
const CROWD_STORAGE_KEY = 'survivor-crowd-picks';
// Your pool size — used to scale national % into an estimated headcount for
// the EV simulation below.
const POOL_SIZE = 39;

function loadCrowdPicks(){
  try{ return JSON.parse(localStorage.getItem(CROWD_STORAGE_KEY) || '{}'); }
  catch(e){ return {}; }
}
function saveCrowdPicks(data){
  localStorage.setItem(CROWD_STORAGE_KEY, JSON.stringify(data));
}
function yahooCrowdPctFor(week, teamFullName){
  if(!yahooCrowdData || !yahooCrowdData.parseHealthy) return null;
  if(Number(week) !== (scheduleData && scheduleData.currentWeek)) return null;
  for(const nickname in yahooCrowdData.picks){
    if(teamFullName.includes(nickname)) return yahooCrowdData.picks[nickname];
  }
  return null;
}
function crowdPctFor(week, team){
  const auto = yahooCrowdPctFor(week, team);
  if(auto != null) return auto;
  const wk = loadCrowdPicks()[week];
  const v = wk && wk[team];
  return (typeof v === 'number' && v >= 0 && v <= 100) ? v : null;
}

// Real expected-pool-share simulation (SurvivorGrid's published method,
// verified against their own worked FAQ example: a 10-person, 2-team case
// where the less-crowded team correctly came out with higher value — 0.126
// vs 0.086 — despite a lower win probability). Enumerates every possible
// combination of GAME results for the week — each game has exactly ONE
// winner (teams facing each other are mutually exclusive outcomes of the
// same game, not independent events) — and a team's value rises when
// winning leaves you in a smaller, less-split group of survivors. Not a
// tunable penalty — every number here is computed, not chosen.
function computeWeekEV(games){
  // games: [{ home, away, homeProb, awayProb, homePickCount, awayPickCount }]
  // — ONE entry per MATCHUP, not per team.
  const n = games.length;
  if(n === 0 || n > 20) return {};
  const ev = {};
  games.forEach(g => { ev[g.home] = 0; ev[g.away] = 0; });
  const totalOutcomes = 1 << n;
  for(let mask = 0; mask < totalOutcomes; mask++){
    let jointProb = 1, survivors = 0;
    for(let i=0;i<n;i++){
      const homeWins = !!(mask & (1 << i));
      jointProb *= homeWins ? games[i].homeProb : games[i].awayProb;
      survivors += homeWins ? games[i].homePickCount : games[i].awayPickCount;
    }
    if(survivors === 0 || jointProb === 0) continue;
    for(let i=0;i<n;i++){
      const homeWins = !!(mask & (1 << i));
      const winner = homeWins ? games[i].home : games[i].away;
      ev[winner] += jointProb / survivors;
    }
  }
  return ev;
}

function computeLiveRecommendation(ignoreCrowd){
  if(!scheduleData || !scheduleData.weeks) return null;

  // weekTeamProb[week][teamName] = { prob, source, sourceLabel, opponent }
  const weekTeamProb = {};
  const allTeamsSeen = new Set();

  for(const wk in scheduleData.weeks){
    weekTeamProb[wk] = {};
    for(const g of scheduleData.weeks[wk].games || []){
      const away = g.away.name, home = g.home.name;
      allTeamsSeen.add(away); allTeamsSeen.add(home);

      // COMPLETED GAME: known outcome, not a probability. Winner is a
      // certain (100%) entry for this week; loser gets no entry at all —
      // you can't retroactively pick a team for a game already lost, and a
      // 0% entry would produce -Infinity in the log-based scoring below.
      if(g.completed){
        if(g.awayWinner){
          weekTeamProb[wk][away] = { prob: 100, source: 'final-result', sourceLabel: 'Final', opponent: home };
        } else if(g.homeWinner){
          weekTeamProb[wk][home] = { prob: 100, source: 'final-result', sourceLabel: 'Final', opponent: away };
        }
        continue;
      }

      const odds = resolveGameOdds(g);
      if(!odds) continue;
      weekTeamProb[wk][away] = { prob: odds.awayProb, source: odds.source, sourceLabel: odds.sourceLabel, opponent: home,
        crowdPct: crowdPctFor(wk, away) };
      weekTeamProb[wk][home] = { prob: odds.homeProb, source: odds.source, sourceLabel: odds.sourceLabel, opponent: away,
        crowdPct: crowdPctFor(wk, home) };
    }
  }

  // Run the real EV simulation for the current week only — the only week
  // with actual crowd data — built per MATCHUP so each game correctly has
  // exactly one winner (see computeWeekEV's comment above).
  const currentWeekKey = String(scheduleData.currentWeek || 1);
  if(scheduleData.weeks[currentWeekKey]){
    const evInputGames = [];
    for(const g of scheduleData.weeks[currentWeekKey].games || []){
      if(g.completed) continue;
      const awayEntry = weekTeamProb[currentWeekKey][g.away.name];
      const homeEntry = weekTeamProb[currentWeekKey][g.home.name];
      if(!awayEntry || !homeEntry) continue;
      if(awayEntry.crowdPct == null || homeEntry.crowdPct == null) continue;
      evInputGames.push({
        home: g.home.name, away: g.away.name,
        homeProb: homeEntry.prob/100, awayProb: awayEntry.prob/100,
        homePickCount: Math.round((homeEntry.crowdPct/100) * POOL_SIZE),
        awayPickCount: Math.round((awayEntry.crowdPct/100) * POOL_SIZE)
      });
    }
    if(evInputGames.length >= 1){
      const evResults = computeWeekEV(evInputGames);
      for(const team in evResults){
        if(weekTeamProb[currentWeekKey][team]) weekTeamProb[currentWeekKey][team].ev = evResults[team];
      }
    }
  }

  // Exclusion set: server-known used teams (from last recommendation.json)
  // UNION whatever's been picked locally in Actuals.
  const serverUsed = new Set((serverRec && serverRec.usedTeamsConsidered) || []);
  const actualPicks = loadActualPicks(); // { week: teamName }
  const actualTeams = new Set(Object.values(actualPicks));
  const excludedTeams = new Set([...serverUsed, ...actualTeams]);

  // Weeks already decided via Actuals are settled — don't recompute a pick
  // for them, start the live plan from the next open week.
  const decidedWeeks = new Set(Object.keys(actualPicks).map(Number));

  const remainingWeeks = Object.keys(weekTeamProb)
    .map(Number)
    .filter(wk => wk >= (scheduleData.currentWeek || 1) && !decidedWeeks.has(wk))
    .sort((a,b)=>a-b);

  const availableTeams = Array.from(allTeamsSeen).filter(t => !excludedTeams.has(t));

  if(remainingWeeks.length === 0 || availableTeams.length === 0){
    return { remainingWeeks, availableTeams, weekAssignments:{}, pick:null, teamsNotInPlan:[], alternatives:[] };
  }

  // Score = log(win probability), OR log(simulated EV) when that's available
  // for this team/week and not explicitly ignored. No tunable constant.
  const scoreMatrix = availableTeams.map(team =>
    remainingWeeks.map(wk => {
      const entry = weekTeamProb[wk] && weekTeamProb[wk][team];
      if(!entry || entry.prob == null || entry.prob <= 0) return null;
      if(!ignoreCrowd && entry.ev != null && entry.ev > 0){
        return Math.log(entry.ev);
      }
      return Math.log(entry.prob / 100);
    })
  );

  const assignment = hungarianMaxAssignment(scoreMatrix);
  const weekAssignments = {};
  const teamsInPlan = new Set();
  assignment.forEach((weekIdx, teamIdx)=>{
    if(weekIdx === -1) return;
    const wk = remainingWeeks[weekIdx];
    const team = availableTeams[teamIdx];
    const entry = weekTeamProb[wk] && weekTeamProb[wk][team];
    if(entry && entry.prob != null){
      weekAssignments[wk] = { team, prob: entry.prob, source: entry.source, sourceLabel: entry.sourceLabel, opponent: entry.opponent, crowdPct: entry.crowdPct, ev: entry.ev };
      teamsInPlan.add(team);
    }
  });

  const teamsNotInPlan = availableTeams.filter(t => !teamsInPlan.has(t));
  const thisWeek = remainingWeeks[0];

  // Top alternatives for THIS week specifically — ranked by that week's win
  // probability alone, not the season-long assignment. This is a different
  // question ("what are my best options this week") than the main pick
  // ("what does the optimal full-season plan say"), so it can legitimately
  // include teams the season-long plan chose to save for later.
  const primaryTeam = weekAssignments[thisWeek] ? weekAssignments[thisWeek].team : null;
  const alternatives = availableTeams
    .filter(t => t !== primaryTeam)
    .map(t => {
      const entry = weekTeamProb[thisWeek] && weekTeamProb[thisWeek][t];
      if(!entry || entry.prob == null) return null;
      return { team: t, prob: entry.prob, opponent: entry.opponent, sourceLabel: entry.sourceLabel };
    })
    .filter(Boolean)
    .sort((a,b) => b.prob - a.prob)
    .slice(0, 3);

  return {
    remainingWeeks,
    availableTeams,
    weekAssignments,
    pick: weekAssignments[thisWeek] ? { week: thisWeek, ...weekAssignments[thisWeek] } : null,
    teamsNotInPlan,
    alternatives
  };
}

// ---------- Recommendation view ----------

function renderOneModel(el, title, live, showCrowdTag){
  const box = document.createElement('div');
  box.style.marginBottom = '18px';

  const heading = document.createElement('div');
  heading.className = 'sub';
  heading.style.marginBottom = '6px';
  heading.style.fontWeight = '700';
  heading.style.color = 'var(--text-dark)';
  heading.textContent = title;
  box.appendChild(heading);

  if(!live || !live.pick){
    box.innerHTML += `<p class="empty">No pick could be computed.</p>`;
    el.appendChild(box);
    return;
  }

  const pick = live.pick;
  const hero = document.createElement('div');
  hero.className = 'rec-hero';
  hero.innerHTML = `
    <div class="rec-week">WEEK ${pick.week}</div>
    <div class="rec-team">${pick.team}</div>
    <div class="rec-detail">vs ${pick.opponent} &middot; ${Math.round(pick.prob)}% win probability</div>
    <div class="rec-source">${pick.sourceLabel || ''}</div>
    ${showCrowdTag && pick.crowdPct != null ? `<div class="rec-source" style="margin-left:6px;border-color:var(--crimson);color:var(--crimson);">${pick.crowdPct}% national pick</div>` : ''}
    ${showCrowdTag && pick.ev != null ? `<div class="rec-source" style="margin-left:6px;">EV ${pick.ev.toFixed(4)}</div>` : ''}
  `;
  box.appendChild(hero);

  if(live.alternatives && live.alternatives.length){
    const altBtn = document.createElement('button');
    altBtn.className = 'ctl-btn';
    altBtn.textContent = 'Show top ' + live.alternatives.length + ' options';
    const altList = document.createElement('div');
    altList.style.display = 'none';
    altList.style.marginTop = '8px';
    live.alternatives.forEach((alt, i)=>{
      const row = document.createElement('div');
      row.className = 'season-plan-row';
      row.innerHTML = `
        <span class="spw">#${i+2}</span>
        <span class="spt">${alt.team} <span style="color:var(--text-dim);font-size:11px;">vs ${alt.opponent}</span></span>
        <span class="spp">${Math.round(alt.prob)}%</span>
      `;
      altList.appendChild(row);
    });
    altBtn.addEventListener('click', ()=>{
      const showing = altList.style.display !== 'none';
      altList.style.display = showing ? 'none' : 'block';
      altBtn.textContent = showing ? 'Show top ' + live.alternatives.length + ' options' : 'Hide options';
    });
    box.appendChild(altBtn);
    box.appendChild(altList);
  }

  const planLabel = document.createElement('div');
  planLabel.className = 'sub';
  planLabel.style.marginTop = '10px';
  planLabel.style.marginBottom = '4px';
  planLabel.textContent = 'FULL SEASON PLAN';
  box.appendChild(planLabel);

  Object.keys(live.weekAssignments).map(Number).sort((a,b)=>a-b).forEach(wk=>{
    const p = live.weekAssignments[wk];
    const row = document.createElement('div');
    row.className = 'season-plan-row';
    row.innerHTML = `
      <span class="spw">Wk ${wk}</span>
      <span class="spt">${p.team}</span>
      <span class="spp">${Math.round(p.prob)}%</span>
    `;
    box.appendChild(row);
  });

  el.appendChild(box);
}

function renderRecommendation(){
  const el = document.getElementById('rec-content');
  el.innerHTML = '';

  if(!scheduleData){
    el.innerHTML = `<p class="empty error">Schedule data hasn't loaded yet.</p>`;
    return;
  }

  const actualPicks = loadActualPicks();
  if(Object.keys(actualPicks).length){
    const note = document.createElement('p');
    note.className = 'sub';
    note.style.marginBottom = '10px';
    const listTxt = Object.keys(actualPicks).map(Number).sort((a,b)=>a-b)
      .map(wk => 'Wk ' + wk + ': ' + actualPicks[wk]).join(', ');
    note.textContent = 'Adjusted for your Actuals picks (' + listTxt + ') — excluded from both plans below.';
    el.appendChild(note);
  }

  const original = computeLiveRecommendation(true);
  const crowdAdjusted = computeLiveRecommendation(false);

  const same = original && crowdAdjusted && original.pick && crowdAdjusted.pick
    && original.pick.team === crowdAdjusted.pick.team;

  renderOneModel(el, 'MODEL A \u2014 WIN PROBABILITY ONLY', original, false);

  if(same){
    const note = document.createElement('p');
    note.className = 'sub';
    note.style.marginTop = '-8px';
    note.style.marginBottom = '14px';
    note.textContent = 'Both models agree this week \u2014 the crowd size didn\u2019t outweigh the win-probability edge.';
    el.appendChild(note);
  }

  renderOneModel(el, 'MODEL B \u2014 EXPECTED POOL SHARE (SIMULATED)', crowdAdjusted, true);

  const yahooNote = document.createElement('p');
  yahooNote.className = 'sub';
  yahooNote.style.marginTop = '10px';
  if(!yahooCrowdData || !yahooCrowdData.parseHealthy){
    yahooNote.textContent = 'Note: national pick-% data hasn\u2019t loaded successfully yet, so Model B is currently identical to Model A.';
    el.appendChild(yahooNote);
  }

  const powerIndexNote = document.createElement('p');
  powerIndexNote.className = 'sub';
  powerIndexNote.style.marginTop = '4px';
  if(!powerIndexData || !powerIndexData.verifiedThisRun){
    powerIndexNote.textContent = 'Note: the ESPN power-index feed hasn\u2019t returned data yet, so far-future weeks are leaning on ESPN\u2019s moneyline odds instead.';
    el.appendChild(powerIndexNote);
  }

  const updated = document.createElement('p');
  updated.className = 'source-note';
  updated.textContent = 'Data as of: schedule ' + timeAgo(scheduleData.updated) +
    ', Kalshi ' + timeAgo(kalshiData && kalshiData.updated) +
    ', power index ' + timeAgo(powerIndexData && powerIndexData.updated) +
    ', national picks ' + timeAgo(yahooCrowdData && yahooCrowdData.updated) + '.';
  el.appendChild(updated);
}

// ---------- Actuals view ----------

function loadActualPicks(){
  try{
    return JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '{}');
  }catch(e){ return {}; }
}
function saveActualPicks(picks){
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(picks));
}

function allTeamNames(){
  const names = new Set();
  for(const wk in scheduleData.weeks || {}){
    for(const g of scheduleData.weeks[wk].games || []){
      names.add(g.away.name);
      names.add(g.home.name);
    }
  }
  return Array.from(names).sort();
}

function renderActuals(){
  const listEl = document.getElementById('actuals-list');
  const copyBlock = document.getElementById('copy-block');
  const copyJson = document.getElementById('copy-json');
  const copyBtn = document.getElementById('copy-btn');

  const teams = allTeamNames();
  const picks = loadActualPicks();
  const weekNums = Object.keys(scheduleData.weeks || {}).map(Number).sort((a,b)=>a-b);

  listEl.innerHTML = '';
  weekNums.forEach(wk=>{
    const row = document.createElement('div');
    row.className = 'actual-row';
    const options = ['<option value="">\u2014</option>']
      .concat(teams.map(t => `<option value="${t}" ${picks[wk]===t?'selected':''}>${t}</option>`))
      .join('');
    row.innerHTML = `
      <span class="aw">Wk ${wk}</span>
      <select data-week="${wk}">${options}</select>
    `;
    row.querySelector('select').addEventListener('change', (e)=>{
      const current = loadActualPicks();
      if(e.target.value){ current[wk] = e.target.value; }
      else { delete current[wk]; }
      saveActualPicks(current);
      updateCopyBlock();
      // Live-update the Recommendation tab immediately, whether or not
      // it's the active tab right now, so switching to it shows the change.
      renderRecommendation();
    });
    listEl.appendChild(row);
  });

  function updateCopyBlock(){
    const current = loadActualPicks();
    const usedList = Object.keys(current).map(Number).sort((a,b)=>a-b).map(wk => current[wk]);
    const deduped = Array.from(new Set(usedList));
    if(deduped.length === 0){
      copyBlock.style.display = 'none';
      return;
    }
    copyBlock.style.display = 'block';
    copyJson.value = JSON.stringify({ used: deduped }, null, 2);
    copyBtn.textContent = 'Copy JSON';
    copyBtn.classList.remove('copied');
  }

  copyBtn.onclick = ()=>{
    copyJson.select();
    try{
      navigator.clipboard.writeText(copyJson.value).then(()=>{
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
      });
    }catch(e){
      document.execCommand('copy');
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
    }
  };

  updateCopyBlock();
}

// ---------- Crowd % view ----------
// Only shows the CURRENT week's teams — pick-percentage data only exists
// once a week's picking window is actually open, so there's nothing
// meaningful to enter for future weeks yet.

function renderCrowdInputs(){
  const listEl = document.getElementById('crowd-list');
  if(!scheduleData || !scheduleData.currentWeek){
    listEl.innerHTML = '<p class="empty">No current week to show yet.</p>';
    return;
  }
  const wk = scheduleData.currentWeek;
  const week = scheduleData.weeks[wk];
  const games = (week && week.games) || [];
  const stored = loadCrowdPicks();
  const wkStored = stored[wk] || {};

  listEl.innerHTML = '';
  if(games.length === 0){
    listEl.innerHTML = '<p class="empty">No games found for the current week.</p>';
    return;
  }

  games.forEach(g=>{
    [g.away, g.home].forEach(team=>{
      const row = document.createElement('div');
      row.className = 'actual-row';
      const existing = wkStored[team.name];
      row.innerHTML = `
        <span class="aw" style="width:auto;flex:1;">${team.name}</span>
        <input type="number" min="0" max="100" step="1" placeholder="%"
          style="width:70px;background:#ffffff;border:1px solid var(--card-border);color:var(--text-dark);border-radius:5px;padding:7px 6px;font-size:13px;"
          value="${existing != null ? existing : ''}">
      `;
      const input = row.querySelector('input');
      input.addEventListener('change', ()=>{
        const data = loadCrowdPicks();
        if(!data[wk]) data[wk] = {};
        const val = input.value === '' ? null : Number(input.value);
        if(val == null || isNaN(val)){
          delete data[wk][team.name];
        } else {
          data[wk][team.name] = Math.max(0, Math.min(100, val));
        }
        saveCrowdPicks(data);
        // Live-update the recommendation immediately, same as Actuals does.
        renderRecommendation();
      });
      listEl.appendChild(row);
    });
  });
}

// ---------- Init ----------

async function init(){
  setStatus('Loading schedule\u2026');
  try{
    scheduleData = await getJSON('data/schedule.json');
    try{ kalshiData = await getJSON('data/kalshi-odds.json'); }
    catch(err){ console.warn('Kalshi data unavailable:', err.message); }
    try{ powerIndexData = await getJSON('data/powerindex.json'); }
    catch(err){ console.warn('Power index data unavailable:', err.message); }
    try{ yahooCrowdData = await getJSON('data/yahoo-crowd.json'); }
    catch(err){ console.warn('Yahoo crowd data unavailable:', err.message); }
    try{ serverRec = await getJSON('data/recommendation.json'); }
    catch(err){ console.warn('Server recommendation unavailable:', err.message); }

    const weekNums = Object.keys(scheduleData.weeks || {}).map(Number);
    if(weekNums.length === 0){
      setStatus('No week data yet. Has the fetch workflow run?');
      return;
    }
    activeWeek = scheduleData.currentWeek && scheduleData.weeks[scheduleData.currentWeek]
      ? scheduleData.currentWeek
      : weekNums.sort((a,b)=>a-b)[0];

    renderTabs();
    renderWeek();
    renderActuals();
  }catch(err){
    console.error(err);
    setStatus("Couldn't load game data: " + err.message + '. Has the fetch workflow run yet?', true);
  }

  renderRecommendation();
}

init();
