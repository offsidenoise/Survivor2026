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
// scripts/recommend.js is duplicated here so the Recommendation tab can
// react instantly to picks made in the Actuals tab, without waiting for a
// round trip through GitHub. Server-side used-teams.json (via
// recommendation.json's usedTeamsConsidered) and this browser's local
// Actuals picks are merged as the exclusion set.
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

// Returns { awayProb, homeProb, source, sourceLabel, updated }
function resolveGameOdds(g){
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

    const card = document.createElement('div');
    card.className = 'game-card';
    card.innerHTML = `
      <div class="game-meta">
        <span>${g.shortName || ''}</span>
        <span>${kickoff}</span>
      </div>
      <div class="matchup">
        <div class="team ${homeFav === false ? 'favorite' : ''}">
          <img class="team-logo" src="${g.away.logo || ''}" alt="" onerror="this.style.display='none'">
          <div>
            <div class="team-name">${g.away.name}</div>
            <div class="team-prob">${awayProb != null ? Math.round(awayProb) + '% implied' : ''}</div>
          </div>
        </div>
        <span class="vs">@</span>
        <div class="team ${homeFav === true ? 'favorite' : ''}">
          <img class="team-logo" src="${g.home.logo || ''}" alt="" onerror="this.style.display='none'">
          <div>
            <div class="team-name">${g.home.name}</div>
            <div class="team-prob">${homeProb != null ? Math.round(homeProb) + '% implied' : ''}</div>
          </div>
        </div>
      </div>
      <div class="odds-line">
        ${odds ? 'Source: ' + odds.sourceLabel + ' &middot; updated ' + timeAgo(odds.updated) : 'No odds available yet for this game.'}
        ${g.espnOdds && g.espnOdds.details ? ' &middot; ' + g.espnOdds.details : ''}
        ${g.espnOdds && g.espnOdds.overUnder ? ' &middot; O/U ' + g.espnOdds.overUnder : ''}
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

function computeLiveRecommendation(){
  if(!scheduleData || !scheduleData.weeks) return null;

  // weekTeamProb[week][teamName] = { prob, source, sourceLabel, opponent }
  const weekTeamProb = {};
  const allTeamsSeen = new Set();

  for(const wk in scheduleData.weeks){
    weekTeamProb[wk] = {};
    for(const g of scheduleData.weeks[wk].games || []){
      const away = g.away.name, home = g.home.name;
      allTeamsSeen.add(away); allTeamsSeen.add(home);
      const odds = resolveGameOdds(g);
      if(!odds) continue;
      weekTeamProb[wk][away] = { prob: odds.awayProb, source: odds.source, sourceLabel: odds.sourceLabel, opponent: home };
      weekTeamProb[wk][home] = { prob: odds.homeProb, source: odds.source, sourceLabel: odds.sourceLabel, opponent: away };
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

  const scoreMatrix = availableTeams.map(team =>
    remainingWeeks.map(wk => {
      const entry = weekTeamProb[wk] && weekTeamProb[wk][team];
      if(!entry || entry.prob == null || entry.prob <= 0) return null;
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
      weekAssignments[wk] = { team, prob: entry.prob, source: entry.source, sourceLabel: entry.sourceLabel, opponent: entry.opponent };
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

async function renderRecommendation(){
  const el = document.getElementById('rec-content');
  el.innerHTML = '<p class="empty">Computing live recommendation&hellip;</p>';

  if(!scheduleData){
    el.innerHTML = `<p class="empty error">Schedule data hasn't loaded yet.</p>`;
    return;
  }

  const live = computeLiveRecommendation();
  el.innerHTML = '';

  const actualPicks = loadActualPicks();
  if(Object.keys(actualPicks).length){
    const note = document.createElement('p');
    note.className = 'sub';
    note.style.marginBottom = '10px';
    const listTxt = Object.keys(actualPicks).map(Number).sort((a,b)=>a-b)
      .map(wk => 'Wk ' + wk + ': ' + actualPicks[wk]).join(', ');
    note.textContent = 'Adjusted for your Actuals picks (' + listTxt + ') — excluded from the plan below.';
    el.appendChild(note);
  }

  if(!live || !live.pick){
    el.innerHTML += `<p class="empty">No pick could be computed &mdash; check that schedule/odds data is populated and you have unused teams left.</p>`;
    return;
  }

  const pick = live.pick;
  const hero = document.createElement('div');
  hero.className = 'rec-hero';
  hero.innerHTML = `
    <div class="rec-week">WEEK ${pick.week} RECOMMENDATION</div>
    <div class="rec-team">${pick.team}</div>
    <div class="rec-detail">vs ${pick.opponent} &middot; ${Math.round(pick.prob)}% win probability</div>
    <div class="rec-source">${pick.sourceLabel}</div>
  `;
  el.appendChild(hero);

  if(live.alternatives && live.alternatives.length){
    const altBtn = document.createElement('button');
    altBtn.className = 'ctl-btn';
    altBtn.textContent = 'Show top ' + live.alternatives.length + ' options for Week ' + pick.week;
    const altList = document.createElement('div');
    altList.style.display = 'none';
    altList.style.marginTop = '8px';
    live.alternatives.forEach((alt, i)=>{
      const row = document.createElement('div');
      row.className = 'season-plan-row';
      row.innerHTML = `
        <span class="spw">#${i+2}</span>
        <span class="spt">${alt.team} <span style="color:var(--steel);font-size:11px;">vs ${alt.opponent}</span></span>
        <span class="spp">${Math.round(alt.prob)}%</span>
      `;
      altList.appendChild(row);
    });
    altBtn.addEventListener('click', ()=>{
      const showing = altList.style.display !== 'none';
      altList.style.display = showing ? 'none' : 'block';
      altBtn.textContent = showing
        ? 'Show top ' + live.alternatives.length + ' options for Week ' + pick.week
        : 'Hide options';
    });
    el.appendChild(altBtn);
    el.appendChild(altList);
  }

  const note2 = document.createElement('p');
  note2.className = 'sub';
  note2.style.marginBottom = '10px';
  note2.style.marginTop = '10px';
  note2.textContent = 'This is the pick that maximizes your odds of surviving the whole remaining season, not just this week — see the full plan below. Recomputed live in this browser, so it updates instantly as you fill in Actuals.';
  el.appendChild(note2);

  const planLabel = document.createElement('div');
  planLabel.className = 'sub';
  planLabel.style.marginBottom = '4px';
  planLabel.textContent = 'FULL SEASON PLAN (subject to change as data updates)';
  el.appendChild(planLabel);

  Object.keys(live.weekAssignments).map(Number).sort((a,b)=>a-b).forEach(wk=>{
    const p = live.weekAssignments[wk];
    const row = document.createElement('div');
    row.className = 'season-plan-row';
    row.innerHTML = `
      <span class="spw">Wk ${wk}</span>
      <span class="spt">${p.team}</span>
      <span class="spp">${Math.round(p.prob)}%</span>
    `;
    el.appendChild(row);
  });

  if(live.teamsNotInPlan && live.teamsNotInPlan.length){
    const label = document.createElement('div');
    label.className = 'sub';
    label.style.marginTop = '14px';
    label.style.marginBottom = '4px';
    label.textContent = 'AVAILABLE BUT NOT CURRENTLY IN THE PLAN';
    el.appendChild(label);
    const note3 = document.createElement('p');
    note3.className = 'sub';
    note3.style.marginBottom = '6px';
    note3.textContent = 'Not gone — just not part of the current best arrangement. Could reappear in a future plan as odds update.';
    el.appendChild(note3);
    const chips = document.createElement('div');
    chips.style.fontSize = '12px';
    chips.style.color = 'var(--steel)';
    chips.textContent = live.teamsNotInPlan.join(', ');
    el.appendChild(chips);
  }

  const powerIndexNote = document.createElement('p');
  powerIndexNote.className = 'sub';
  powerIndexNote.style.marginTop = '10px';
  if(!powerIndexData || !powerIndexData.verifiedThisRun){
    powerIndexNote.textContent = 'Note: the ESPN power-index feed hasn\u2019t returned data yet, so far-future weeks are leaning on ESPN\u2019s moneyline odds instead.';
    el.appendChild(powerIndexNote);
  }

  const updated = document.createElement('p');
  updated.className = 'source-note';
  updated.textContent = 'Data as of: schedule ' + timeAgo(scheduleData.updated) +
    ', Kalshi ' + timeAgo(kalshiData && kalshiData.updated) +
    ', power index ' + timeAgo(powerIndexData && powerIndexData.updated) + '.';
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

// ---------- Init ----------

async function init(){
  setStatus('Loading schedule\u2026');
  try{
    scheduleData = await getJSON('data/schedule.json');
    try{ kalshiData = await getJSON('data/kalshi-odds.json'); }
    catch(err){ console.war

