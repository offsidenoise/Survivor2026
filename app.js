// NFL Week Odds
// Reads pre-fetched, same-origin JSON files written by the scheduled
// GitHub Action — no live browser calls, no CORS risk:
//   data/schedule.json       — ESPN schedule for all 18 weeks + moneyline odds
//   data/kalshi-odds.json    — Kalshi's real-money market prices, when available
//   data/recommendation.json — the season-optimal pick engine's output
//
// The Actuals tab is the one piece of this that's genuinely client-side
// only: there's no backend here, so "which team did I actually pick" can't
// write back into the repo's data/used-teams.json by itself. It saves to
// this browser's localStorage instead, and generates the JSON to paste in
// by hand — see the README for why.

const LOCAL_STORAGE_KEY = 'survivor-actual-picks';

const statusEl = document.getElementById('status');
const gamesEl = document.getElementById('games');
const sourceNoteEl = document.getElementById('source-note');
const tabsEl = document.getElementById('week-tabs');
const viewTabsEl = document.getElementById('view-tabs');

let scheduleData = null;
let kalshiData = null;
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

// ---------- View switching ----------

viewTabsEl.querySelectorAll('.view-tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    viewTabsEl.querySelectorAll('.view-tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.view-panel').forEach(p=>p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('view-' + tab.dataset.view).classList.add('active');
    document.getElementById('week-tabs').style.display = tab.dataset.view === 'schedule' ? 'flex' : 'none';
  });
});

// ---------- Schedule view ----------

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
    const kalshi = kalshiEntryFor(g.away.name, g.home.name);
    const espn = g.espnOdds;

    let awayProb = null, homeProb = null, source = null;
    if(kalshi){
      awayProb = kalshi.awayProb; homeProb = kalshi.homeProb; source = 'Kalshi';
    } else if(espn && espn.awayProb != null && espn.homeProb != null){
      awayProb = espn.awayProb; homeProb = espn.homeProb; source = 'ESPN moneyline';
    }

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
        ${source ? 'Source: ' + source : 'No odds available yet for this game.'}
        ${espn && espn.details ? ' &middot; ' + espn.details : ''}
        ${espn && espn.overUnder ? ' &middot; O/U ' + espn.overUnder : ''}
      </div>
    `;
    gamesEl.appendChild(card);
  });

  const scheduleAge = scheduleData.updated ? new Date(scheduleData.updated).toLocaleString() : 'unknown';
  const kalshiAge = kalshiData && kalshiData.updated ? new Date(kalshiData.updated).toLocaleString() : 'unavailable';
  sourceNoteEl.innerHTML =
    `Schedule + ESPN odds last fetched ${scheduleAge}. Kalshi prices last fetched ${kalshiAge}. ` +
    `Both refresh on a schedule via GitHub Actions, not on page load.`;
}

// ---------- Recommendation view ----------

async function renderRecommendation(){
  const el = document.getElementById('rec-content');
  el.innerHTML = '<p class="empty">Loading recommendation&hellip;</p>';
  let rec;
  try{
    rec = await getJSON('data/recommendation.json');
  }catch(err){
    el.innerHTML = `<p class="empty error">No recommendation yet. Has recommend.js run in the Action?</p>`;
    return;
  }

  el.innerHTML = '';

  if(!rec.recommendation || !rec.recommendation.pick){
    el.innerHTML = `<p class="empty">No pick could be computed yet &mdash; check that schedule, Kalshi, and used-teams data are all populated.</p>`;
    return;
  }

  const pick = rec.recommendation.pick;
  const hero = document.createElement('div');
  hero.className = 'rec-hero';
  hero.innerHTML = `
    <div class="rec-week">WEEK ${rec.recommendation.week} RECOMMENDATION</div>
    <div class="rec-team">${pick.team}</div>
    <div class="rec-detail">vs ${pick.opponent} &middot; ${Math.round(pick.prob)}% win probability</div>
    <div class="rec-source">${pick.source === 'kalshi' ? 'Kalshi market' : pick.source === 'powerindex' ? 'ESPN power index' : 'ESPN moneyline'}</div>
  `;
  el.appendChild(hero);

  const note = document.createElement('p');
  note.className = 'sub';
  note.style.marginBottom = '10px';
  note.textContent = 'This is the pick that maximizes your odds of surviving the whole remaining season, not just this week — see the full plan below.';
  el.appendChild(note);

  const planLabel = document.createElement('div');
  planLabel.className = 'sub';
  planLabel.style.marginBottom = '4px';
  planLabel.textContent = 'FULL SEASON PLAN (subject to change as data updates)';
  el.appendChild(planLabel);

  const plan = rec.recommendation.fullSeasonPlan || {};
  Object.keys(plan).map(Number).sort((a,b)=>a-b).forEach(wk=>{
    const p = plan[wk];
    const row = document.createElement('div');
    row.className = 'season-plan-row';
    row.innerHTML = `
      <span class="spw">Wk ${wk}</span>
      <span class="spt">${p.team}</span>
      <span class="spp">${Math.round(p.prob)}%</span>
    `;
    el.appendChild(row);
  });

  if(!rec.powerIndexHealthy){
    const warn = document.createElement('p');
    warn.className = 'sub';
    warn.style.marginTop = '10px';
    warn.textContent = 'Note: the ESPN power-index feed hasn\u2019t returned data yet, so far-future weeks are leaning on ESPN\u2019s moneyline odds instead.';
    el.appendChild(warn);
  }

  const updated = document.createElement('p');
  updated.className = 'source-note';
  updated.textContent = 'Last computed ' + (rec.updated ? new Date(rec.updated).toLocaleString() : 'unknown') +
    '. Recomputes on the same schedule as the odds data.';
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
    });
    listEl.appendChild(row);
  });

  function updateCopyBlock(){
    const current = loadActualPicks();
    const usedList = Object.keys(current).map(Number).sort((a,b)=>a-b).map(wk => current[wk]);
    // de-duplicate while preserving order, in case the same team name shows twice
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
    try{
      kalshiData = await getJSON('data/kalshi-odds.json');
    }catch(err){
      console.warn('Kalshi data unavailable, falling back to ESPN-only:', err.message);
    }

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
