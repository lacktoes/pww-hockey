/* app.js — PWW Hockey Dashboard */

const STAT_LABELS = ["G","A","PIM","PPP","SOG","FW","HIT","BLK","W","SV","SV%","SHO"];
const CAT_WEIGHTS = [100,100,100,100,100,100,100,100,100,100,100,50];

const CAT_COLORS = {};
STAT_LABELS.forEach((s, i) => { CAT_COLORS[s] = `hsl(${i * 30}, 70%, 55%)`; });

let appData       = null;
let selectedWeek  = null;
let availWeeks    = [];
let radarSelected = new Set();
let linesSelected = new Set();
let activeTab     = "weekly";
let manifest      = null;   // docs/seasons.json, or null on a single-season deploy
let curSeason     = null;
let applyingHash  = false;  // guards the hashchange listener against our own writes

// ── Bootstrap ───────────────────────────────────────────────────────────────
async function init() {
  try {
    manifest = await loadManifest();
    initTabs();
    initAllPlayControls();
    initSeasonPicker();
    const want = parseHash();
    const season = (manifest && manifest.seasons.some(s => s.season === want.season))
      ? want.season
      : (manifest ? manifest.current : null);
    await loadSeason(season, want.week);
  } catch (e) {
    show("error");
  }
}

/**
 * The season manifest is optional. Without it the dashboard falls back to the
 * single data.json it has always read, so the page keeps working on a deploy
 * where the multi-season fetch has not run yet.
 */
async function loadManifest() {
  try {
    const res = await fetch("seasons.json", { cache: "no-cache" });
    if (!res.ok) return null;
    const m = await res.json();
    return (m && Array.isArray(m.seasons) && m.seasons.length) ? m : null;
  } catch (e) {
    return null;
  }
}

async function loadSeason(season, wantWeek) {
  show("loading");

  const entry = manifest && manifest.seasons.find(s => s.season === season);
  const file  = entry ? entry.file : "data.json";

  const res = await fetch(file, { cache: "no-cache" });
  if (!res.ok) throw new Error(res.statusText);

  appData    = await res.json();
  curSeason  = season || (appData.meta && appData.meta.season) || null;
  availWeeks = Object.keys(appData.weeks).map(Number).sort((a, b) => a - b);

  // Highlight selections belong to the season being left behind.
  radarSelected.clear();
  linesSelected.clear();

  syncSeasonPicker();

  // Prefer the requested week, else the live week, else the last week with data.
  const startWeek =
    (wantWeek && appData.weeks[String(wantWeek)]) ? wantWeek
    : appData.weeks[String(appData.meta.current_week)] ? appData.meta.current_week
    : availWeeks[availWeeks.length - 1];

  selectWeek(startWeek);
  showTab(activeTab);   // re-assert panel visibility and re-render the season tab
}

// ── Season picker ───────────────────────────────────────────────────────────
function initSeasonPicker() {
  const wrap = document.getElementById("season-picker");
  const sel  = document.getElementById("season-select");
  if (!wrap || !sel || !manifest) return;

  sel.innerHTML = manifest.seasons.map(s => {
    const suffix = s.complete ? "" : " (live)";
    return `<option value="${s.season}">${s.season}${suffix}</option>`;
  }).join("");
  wrap.hidden = false;

  sel.addEventListener("change", async () => {
    try {
      await loadSeason(sel.value, null);
      writeHash();
    } catch (e) {
      show("error");
    }
  });
}

function syncSeasonPicker() {
  const sel = document.getElementById("season-select");
  if (sel && curSeason) sel.value = curSeason;
}

// ── URL hash (shareable links: #season=2024-25&week=12) ─────────────────────
function parseHash() {
  const h = (location.hash || "").replace(/^#/, "");
  const out = { season: null, week: null };
  for (const part of h.split("&")) {
    const [k, v] = part.split("=");
    if (k === "season" && v) out.season = decodeURIComponent(v);
    if (k === "week" && v && !isNaN(Number(v))) out.week = Number(v);
  }
  return out;
}

function writeHash() {
  if (selectedWeek == null) return;
  const parts = [];
  if (curSeason) parts.push("season=" + encodeURIComponent(curSeason));
  parts.push("week=" + selectedWeek);
  const next = "#" + parts.join("&");
  if (location.hash === next) return;
  applyingHash = true;
  history.replaceState(null, "", next);
  applyingHash = false;
}

window.addEventListener("hashchange", async () => {
  if (applyingHash) return;
  const want = parseHash();
  try {
    if (want.season && want.season !== curSeason
        && manifest && manifest.seasons.some(s => s.season === want.season)) {
      await loadSeason(want.season, want.week);
    } else if (want.week && want.week !== selectedWeek && appData.weeks[String(want.week)]) {
      selectWeek(want.week);
    }
  } catch (e) {
    show("error");
  }
});

// ── Tabs ────────────────────────────────────────────────────────────────────
function initTabs() {
  document.getElementById("tab-weekly").addEventListener("click", () => showTab("weekly"));
  document.getElementById("tab-season").addEventListener("click", () => showTab("season"));
}

function showTab(tab) {
  activeTab = tab;
  document.getElementById("tab-weekly").classList.toggle("tab-active", tab === "weekly");
  document.getElementById("tab-season").classList.toggle("tab-active", tab === "season");
  document.getElementById("panel-weekly").hidden = (tab !== "weekly");
  document.getElementById("panel-season").hidden = (tab !== "season");
  document.getElementById("week-nav").hidden     = (tab !== "weekly");
  if (tab === "season") renderSeasonPage();
}

function selectWeek(week) {
  selectedWeek = week;
  radarSelected.clear();
  renderWeek(week);
  updateNav();
  writeHash();
}

// ── Navigation ──────────────────────────────────────────────────────────────
function updateNav() {
  const idx     = availWeeks.indexOf(selectedWeek);
  const prevBtn = document.getElementById("prev-btn");
  const nextBtn = document.getElementById("next-btn");
  prevBtn.disabled = (idx <= 0);
  nextBtn.disabled = (idx >= availWeeks.length - 1);
  prevBtn.onclick  = () => selectWeek(availWeeks[idx - 1]);
  nextBtn.onclick  = () => selectWeek(availWeeks[idx + 1]);
}

document.addEventListener("keydown", e => {
  if (activeTab !== "weekly") return;
  const idx = availWeeks.indexOf(selectedWeek);
  if (e.key === "ArrowLeft"  && idx > 0)                    selectWeek(availWeeks[idx - 1]);
  if (e.key === "ArrowRight" && idx < availWeeks.length - 1) selectWeek(availWeeks[idx + 1]);
});

// ── Render a week ───────────────────────────────────────────────────────────
function renderWeek(week) {
  const wk = appData.weeks[String(week)];

  document.getElementById("week-label").textContent    = "Week " + week;
  document.title = (curSeason ? curSeason + " · " : "") + "Week " + week + " — PWW Hockey";
  document.getElementById("live-badge").hidden         = !wk.is_current;
  document.getElementById("last-updated").textContent  =
    "Updated " + fmtDate(appData.meta.last_updated);

  const catContribs = computeCatContribs(wk);

  document.getElementById("podium-container").innerHTML   = renderPodium(wk);
  renderStackedBars(wk, catContribs);
  document.getElementById("matchups-container").innerHTML = renderMatchups(wk);
  document.getElementById("stats-table").innerHTML        = renderStatsTable(wk, week);
  document.getElementById("leaders-container").innerHTML  = renderLeaders(wk);
  renderRadarChart(wk);

  show("content");
}

// ── Per-category normalised score breakdown ─────────────────────────────────
function computeCatContribs(wk) {
  const teams  = Object.keys(wk.stats || {});
  const result = {};
  STAT_LABELS.forEach((stat, i) => {
    const vals  = teams.map(t => Number(wk.stats[t][stat]) || 0);
    const min   = Math.min(...vals);
    const max   = Math.max(...vals);
    const range = max - min || 1;
    teams.forEach(t => {
      if (!result[t]) result[t] = {};
      result[t][stat] = ((Number(wk.stats[t][stat]) - min) / range) * CAT_WEIGHTS[i];
    });
  });
  return result;
}

// ── Standings helpers ───────────────────────────────────────────────────────
// Yahoo scores points per CATEGORY: win=2, tie=1, loss=0 (24 pts/matchup, avg 12/team/week)
function computeStandingsThrough(upToWeek) {
  const records = {};
  for (const wk of availWeeks) {
    if (wk > upToWeek) break;
    const weekObj = appData.weeks[String(wk)];
    if (!weekObj || weekObj.is_current) continue;
    for (const m of weekObj.matchups || []) {
      for (const [team, side] of [[m.t1, "1"], [m.t2, "2"]]) {
        if (!records[team]) records[team] = { W: 0, L: 0, T: 0, pts: 0 };
        for (const cat of m.cats) {
          if      (cat === side) { records[team].W++; records[team].pts += 2; }
          else if (cat === "T")  { records[team].T++; records[team].pts += 1; }
          else                   { records[team].L++; }
        }
      }
    }
  }
  return records;
}

function rankTeams(records) {
  const teams = Object.keys(records);
  teams.sort((a, b) => {
    const ra = records[a], rb = records[b];
    if (rb.pts !== ra.pts) return rb.pts - ra.pts;
    return rb.W - ra.W;
  });
  const rank = {};
  teams.forEach((t, i) => { rank[t] = i + 1; });
  return rank;
}

function getWeekMovement(week, isLive) {
  if (isLive) return {};
  const recCurr  = computeStandingsThrough(week);
  const recPrev  = computeStandingsThrough(week - 1);
  const rankCurr = rankTeams(recCurr);
  const rankPrev = rankTeams(recPrev);
  const movement = {};
  for (const team of Object.keys(rankCurr)) {
    const prev = rankPrev[team];
    movement[team] = prev !== undefined ? prev - rankCurr[team] : 0;
  }
  return movement;
}

// ── Hot / Cold streaks ───────────────────────────────────────────────────────
function computeStreaks() {
  const completed = availWeeks.filter(w => !appData.weeks[String(w)].is_current);
  const rankHist  = {};
  completed.slice(-4).forEach(w => {
    (appData.weeks[String(w)].leaderboard || []).forEach((team, idx) => {
      if (!rankHist[team]) rankHist[team] = [];
      rankHist[team].push(idx + 1); // 1 = best rank
    });
  });
  const result = {};
  for (const [team, ranks] of Object.entries(rankHist)) {
    if (ranks.length < 3) continue;
    const r = ranks.slice(-3);
    if (r[0] > r[1] && r[1] > r[2]) result[team] = "🔥"; // rank # falling = improving
    else if (r[0] < r[1] && r[1] < r[2]) result[team] = "🧊"; // rank # rising = declining
  }
  return result;
}

// ── 1. Podium ────────────────────────────────────────────────────────────────
function renderPodium(wk) {
  const board = wk.leaderboard || [];
  if (board.length < 3) return "<p style='color:var(--text-2);text-align:center'>Not enough data</p>";

  const medals   = ["🥇","🥈","🥉"];
  const posClass = ["first","second","third"];
  const order    = [1, 0, 2];
  const streaks  = computeStreaks();

  return order.map(rank => {
    const name   = board[rank];
    const score  = (wk.pww[name] || 0).toFixed(1);
    const pos    = posClass[rank];
    const streak = streaks[name] ? `<span class="streak-badge">${streaks[name]}</span>` : "";

    return `
    <div class="podium-slot podium-${pos}">
      <div class="podium-info">
        ${logoImg(name, "podium-logo", pos === "first" ? 90 : pos === "second" ? 72 : 64)}
        <div class="podium-medal">${medals[rank]}</div>
        <div class="podium-name" title="${name}">${name}${streak}</div>
        <div class="podium-score">${score}</div>
      </div>
      <div class="podium-block podium-block-${pos}">${rank + 1}</div>
    </div>`;
  }).join("");
}

// ── 2. Stacked bar chart ─────────────────────────────────────────────────────
function renderStackedBars(wk, catContribs) {
  const board    = wk.leaderboard || [];
  const maxScore = wk.pww[board[0]] || 1;

  const barsHtml = board.map(name => {
    const total  = wk.pww[name] || 0;
    const widPct = (total / maxScore * 100).toFixed(1);
    const segs   = STAT_LABELS.map(stat => {
      const contrib = catContribs[name]?.[stat] || 0;
      const pct     = total > 0 ? (contrib / total * 100).toFixed(2) : 0;
      return `<div class="bar-seg" style="width:${pct}%;background:${CAT_COLORS[stat]}"
                   title="${stat}: ${contrib.toFixed(1)}"></div>`;
    }).join("");

    return `
    <div class="bar-row">
      <div class="bar-label">
        ${smLogoImg(name)}
        <span title="${name}">${shortName(name)}</span>
      </div>
      <div class="bar-track" style="--bar-pct:${widPct}%">
        ${segs}
      </div>
      <span class="bar-score">${total.toFixed(0)}</span>
    </div>`;
  }).join("");

  const legendHtml = STAT_LABELS.map(s =>
    `<span class="legend-item">
       <span class="legend-swatch" style="background:${CAT_COLORS[s]}"></span>${s}
     </span>`
  ).join("");

  document.getElementById("bars-container").innerHTML = barsHtml;
  document.getElementById("bars-legend").innerHTML    = legendHtml;
}

// ── 3. Stats heatmap table — sorted by league standings ──────────────────────
function renderStatsTable(wk, week) {
  const isLive      = wk.is_current;
  const standingsWk = isLive ? Math.max(...availWeeks.filter(w => w < week)) : week;
  const records     = computeStandingsThrough(standingsWk);
  const movement    = getWeekMovement(week, isLive);
  const streaks     = computeStreaks();
  const allTeams    = Object.keys(wk.stats || {});

  const ranked = [...allTeams].sort((a, b) => {
    const ra = records[a], rb = records[b];
    if (!ra && !rb) return 0;
    if (!ra) return 1;
    if (!rb) return -1;
    if (rb.pts !== ra.pts) return rb.pts - ra.pts;
    return rb.W - ra.W;
  });

  const colRange = {};
  STAT_LABELS.forEach(stat => {
    const vals     = ranked.map(t => Number(wk.stats[t]?.[stat]) || 0);
    colRange[stat] = { min: Math.min(...vals), max: Math.max(...vals) };
  });

  const header = `<thead><tr>
    <th class="th-rank">#</th>
    <th class="th-team">Team</th>
    <th class="th-pww">PWW</th>
    ${STAT_LABELS.map(s => `<th>${s}</th>`).join("")}
  </tr></thead>`;

  const rows = ranked.map((name, i) => {
    const pww   = (wk.pww[name] || 0).toFixed(1);
    const delta = movement[name];
    let mvBadge = "";
    if (delta > 0)      mvBadge = `<span class="mv-up">▲${delta}</span>`;
    else if (delta < 0) mvBadge = `<span class="mv-dn">▼${Math.abs(delta)}</span>`;

    const cells = STAT_LABELS.map(stat => {
      const raw          = wk.stats[name]?.[stat];
      const num          = Number(raw) || 0;
      const { min, max } = colRange[stat];
      const t            = (num - min) / (max - min || 1);
      const bg           = `hsl(${(t * 120).toFixed(0)}, 65%, 28%)`;
      return `<td style="background:${bg}">${fmtStat(stat, raw)}</td>`;
    }).join("");

    return `<tr>
      <td class="td-rank">${i + 1}</td>
      <td class="td-team">
        <div class="td-team-inner">
          ${smLogoImg(name)}
          <span title="${name}">${name}</span>
          ${mvBadge}${streaks[name] ? `<span class="streak-badge">${streaks[name]}</span>` : ""}
        </div>
      </td>
      <td class="td-pww">${pww}</td>
      ${cells}
    </tr>`;
  }).join("");

  return header + `<tbody>${rows}</tbody>`;
}

// ── 4. Matchups — head-to-head category score ────────────────────────────────
function renderMatchups(wk) {
  return wk.matchups.map(m => {
    const t1 = m.t1, t2 = m.t2;
    const stats1 = wk.stats[t1] ?? {}, stats2 = wk.stats[t2] ?? {};

    const t1w  = m.cats.filter(c => c === "1").length;
    const t2w  = m.cats.filter(c => c === "2").length;
    const ties = m.cats.filter(c => c === "T").length;
    const s1   = t1w + 0.5 * ties;
    const win1 = s1 > 6;
    const win2 = s1 < 6;

    const scoreLabel = `${t1w}–${t2w}`;
    const p1 = wk.pww?.[t1] || 0, p2 = wk.pww?.[t2] || 0;
    const pwwGap = wk.is_current
      ? `<div class="matchup-pww-gap">${p1.toFixed(1)} <span class="pww-gap-sep">pts vs</span> ${p2.toFixed(1)}</div>`
      : "";

    const pills = m.cats.map((c, i) => {
      const label = STAT_LABELS[i];
      const cls   = c === "1" ? "cat-1" : c === "2" ? "cat-2" : "cat-tie";
      return `<span class="cat-pill ${cls}"
                    title="${label}: ${fmtStat(label, stats1[label])} vs ${fmtStat(label, stats2[label])}">${label}</span>`;
    }).join("");

    return `
    <div class="matchup-card">
      <div class="matchup-teams">
        <div class="team-side ${win1 ? "winning" : ""}">
          ${logoImg(t1, "team-logo", 42)}
          <div class="team-info">
            <div class="team-name" title="${t1}">${t1}</div>
            <div class="team-cat-score">${t1w}</div>
          </div>
        </div>
        <div class="matchup-vs">${scoreLabel}</div>
        <div class="team-side team-side--right ${win2 ? "winning" : ""}">
          <div class="team-info">
            <div class="team-name" title="${t2}">${t2}</div>
            <div class="team-cat-score">${t2w}</div>
          </div>
          ${logoImg(t2, "team-logo", 42)}
        </div>
      </div>
      ${pwwGap}
      <div class="cat-strip">${pills}</div>
    </div>`;
  }).join("");
}

// ── 5. Category leaders ──────────────────────────────────────────────────────
function renderLeaders(wk) {
  return STAT_LABELS.map(stat => {
    const leader = wk.leaders?.[stat];
    if (!leader) return "";
    const val = wk.stats?.[leader]?.[stat];
    return `
    <div class="leader-tile">
      <div class="leader-stat">${stat}</div>
      ${logoImg(leader, "leader-logo", 34)}
      <div class="leader-team" title="${leader}">${shortName(leader)}</div>
      <div class="leader-value">${fmtStat(stat, val)}</div>
    </div>`;
  }).join("");
}

// ── 6. Radar / Spider chart ──────────────────────────────────────────────────
function renderRadarChart(wk) {
  const teams = Object.keys(wk.stats || {});
  if (!teams.length) return;

  const norm = {};
  teams.forEach(t => { norm[t] = {}; });
  STAT_LABELS.forEach(stat => {
    const vals = teams.map(t => Number(wk.stats[t][stat]) || 0);
    const min  = Math.min(...vals);
    const rng  = (Math.max(...vals) - min) || 1;
    teams.forEach(t => { norm[t][stat] = (Number(wk.stats[t][stat]) - min) / rng; });
  });

  const cx = 210, cy = 215, R = 165;
  const N   = STAT_LABELS.length;
  const ang = i => (2 * Math.PI * i / N) - Math.PI / 2;
  const pt  = (i, v) => [cx + v * R * Math.cos(ang(i)), cy + v * R * Math.sin(ang(i))];

  const gridRings = [0.25, 0.5, 0.75, 1.0].map(v => {
    const pts = STAT_LABELS.map((_, i) => pt(i, v).join(",")).join(" ");
    return `<polygon points="${pts}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`;
  }).join("");

  const axes = STAT_LABELS.map((s, i) => {
    const [x, y]   = pt(i, 1);
    const [lx, ly] = pt(i, 1.2);
    const cos       = Math.cos(ang(i));
    const anchor    = cos > 0.1 ? "start" : cos < -0.1 ? "end" : "middle";
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"
              stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
            <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}"
              dominant-baseline="central" font-size="11" fill="rgba(255,255,255,0.55)"
              font-family="sans-serif">${s}</text>`;
  }).join("");

  const someSelected = radarSelected.size > 0;
  const sortedTeams  = [...teams].sort();

  const polygons = sortedTeams.map(name => {
    const hue        = teamHue(name);
    const isSelected = radarSelected.has(name);
    const strokeOp   = !someSelected ? 0.65 : isSelected ? 1.0 : 0.1;
    const fillOp     = isSelected ? 0.18 : 0;
    const strokeW    = !someSelected ? 1.5 : isSelected ? 2.5 : 1;

    const pts = STAT_LABELS.map((s, i) => {
      const v = norm[name][s] * 0.92 + 0.04;
      return pt(i, v).map(n => n.toFixed(1)).join(",");
    }).join(" ");

    return `<polygon class="radar-poly" data-team="${name}" points="${pts}"
      fill="hsla(${hue},70%,60%,${fillOp})"
      stroke="hsl(${hue},70%,60%)"
      stroke-width="${strokeW}"
      stroke-opacity="${strokeOp}"
      style="cursor:pointer;transition:stroke-opacity 0.2s"/>`;
  }).join("");

  const legend = sortedTeams.map((name, i) => {
    const hue    = teamHue(name);
    const active = !someSelected || radarSelected.has(name);
    const ly     = 28 + i * 27;
    return `<g class="radar-legend-item" data-team="${name}" style="cursor:pointer">
      <rect x="430" y="${ly}" width="13" height="13" rx="2"
        fill="hsl(${hue},70%,60%)" opacity="${active ? 1 : 0.25}"/>
      <text x="450" y="${ly + 6}" dominant-baseline="central" font-size="12"
        fill="${active ? "#e6edf3" : "#484f58"}"
        font-family="sans-serif">${shortName(name)}</text>
    </g>`;
  }).join("");

  const svgH      = Math.max(440, 28 + sortedTeams.length * 27 + 20);
  const container = document.getElementById("radar-container");
  container.innerHTML = `<svg viewBox="0 0 680 ${svgH}"
    xmlns="http://www.w3.org/2000/svg" style="width:100%;max-height:${svgH}px">
    ${gridRings}${axes}${polygons}${legend}
  </svg>`;

  container.querySelectorAll(".radar-poly, .radar-legend-item").forEach(el => {
    el.addEventListener("click", () => {
      const name = el.dataset.team;
      if (radarSelected.has(name)) radarSelected.delete(name);
      else radarSelected.add(name);
      renderRadarChart(wk);
    });
  });
}

function teamHue(name) {
  let h = 0;
  for (const c of name) h = ((h * 31) + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 360;
}

// ── Season-wide analytics helpers ────────────────────────────────────────────
function computeSOS() {
  const sos = {};
  for (const wk of availWeeks) {
    const weekObj = appData.weeks[String(wk)];
    if (!weekObj || weekObj.is_current) continue;
    for (const m of weekObj.matchups || []) {
      const pww = weekObj.pww || {};
      if (pww[m.t2] !== undefined) {
        if (!sos[m.t1]) sos[m.t1] = { total: 0, n: 0 };
        sos[m.t1].total += pww[m.t2]; sos[m.t1].n++;
      }
      if (pww[m.t1] !== undefined) {
        if (!sos[m.t2]) sos[m.t2] = { total: 0, n: 0 };
        sos[m.t2].total += pww[m.t1]; sos[m.t2].n++;
      }
    }
  }
  const result = {};
  for (const [t, d] of Object.entries(sos)) result[t] = d.n ? d.total / d.n : 0;
  return result;
}

function computeH2H() {
  // Tracks total category wins (not matchup wins) across all meetings
  // e.g. two meetings of 8-4 and 7-5 → 15-9
  const h2h = {};
  for (const wk of availWeeks) {
    const weekObj = appData.weeks[String(wk)];
    if (!weekObj || weekObj.is_current) continue;
    for (const m of weekObj.matchups || []) {
      const { t1, t2, cats } = m;
      [t1, t2].forEach(t => { if (!h2h[t]) h2h[t] = {}; });
      if (!h2h[t1][t2]) h2h[t1][t2] = { W: 0, L: 0 };
      if (!h2h[t2][t1]) h2h[t2][t1] = { W: 0, L: 0 };
      const t1cats = cats.filter(c => c === "1").length;
      const t2cats = cats.filter(c => c === "2").length;
      h2h[t1][t2].W += t1cats; h2h[t1][t2].L += t2cats;
      h2h[t2][t1].W += t2cats; h2h[t2][t1].L += t1cats;
    }
  }
  return h2h;
}

function computeCatWinRates() {
  const rates = {};
  for (const wk of availWeeks) {
    const weekObj = appData.weeks[String(wk)];
    if (!weekObj || weekObj.is_current) continue;
    for (const m of weekObj.matchups || []) {
      const { t1, t2, cats } = m;
      [t1, t2].forEach(t => {
        if (!rates[t]) { rates[t] = {}; STAT_LABELS.forEach(s => { rates[t][s] = { W: 0, L: 0, T: 0 }; }); }
      });
      cats.forEach((r, i) => {
        const s = STAT_LABELS[i];
        if      (r === "1") { rates[t1][s].W++; rates[t2][s].L++; }
        else if (r === "2") { rates[t1][s].L++; rates[t2][s].W++; }
        else                { rates[t1][s].T++; rates[t2][s].T++; }
      });
    }
  }
  return rates;
}

// ── Season page ──────────────────────────────────────────────────────────────
function renderSeasonPage() {
  const completedWeeks = availWeeks.filter(w => !appData.weeks[String(w)].is_current);
  const teamNames      = Object.keys(appData.teams);

  const ss = {};
  teamNames.forEach(name => {
    ss[name] = { first: 0, second: 0, third: 0, totalPww: 0, scores: [],
                 statTotals: {}, statCounts: {} };
    STAT_LABELS.forEach(s => { ss[name].statTotals[s] = 0; ss[name].statCounts[s] = 0; });
  });

  const weeklyResults = completedWeeks.map(w => {
    const wk    = appData.weeks[String(w)];
    const board = wk.leaderboard || [];
    const [first, second, third] = board;
    if (first  && ss[first])  ss[first].first++;
    if (second && ss[second]) ss[second].second++;
    if (third  && ss[third])  ss[third].third++;

    for (const [name, pww] of Object.entries(wk.pww || {})) {
      if (!ss[name]) continue;
      ss[name].totalPww += pww;
      ss[name].scores.push({ week: w, score: pww });
      STAT_LABELS.forEach(s => {
        const v = wk.stats?.[name]?.[s];
        if (v !== undefined) { ss[name].statTotals[s] += Number(v); ss[name].statCounts[s]++; }
      });
    }
    return { week: w, first, second, third };
  });

  const sorted = teamNames
    .filter(n => ss[n].scores.length > 0)
    .sort((a, b) => {
      if (ss[b].first  !== ss[a].first)  return ss[b].first  - ss[a].first;
      if (ss[b].second !== ss[a].second) return ss[b].second - ss[a].second;
      return ss[b].totalPww - ss[a].totalPww;
    });

  // Weekly results — horizontal card per week
  function wkrPlace(medal, team, pwwScore) {
    if (!team) return "";
    const score = pwwScore !== undefined ? `<span class="wkr-score">${fmtNum(pwwScore)}</span>` : "";
    const short  = team.length > 14 ? team.slice(0, 13) + "…" : team;
    return `<div class="wkr-place">
      <span class="wkr-medal">${medal}</span>
      ${smLogoImg(team)}
      <span class="wkr-name" title="${team}">${short}</span>
      ${score}
    </div>`;
  }

  const wkCards = weeklyResults.map(({ week, first, second, third }) => {
    const wkPww = appData.weeks[String(week)]?.pww || {};
    return `<div class="wkr-card">
      <div class="wkr-weeknum">Wk ${week}</div>
      <div class="wkr-places">
        ${wkrPlace("🥇", first,  wkPww[first])}
        ${wkrPlace("🥈", second, wkPww[second])}
        ${wkrPlace("🥉", third,  wkPww[third])}
      </div>
    </div>`;
  }).join("");

  const wkTable = `<div class="wkr-grid">${wkCards}</div>`;

  // Season summary (with SOS column)
  const sos      = computeSOS();
  const sosVals  = Object.values(sos);
  const sosMin   = Math.min(...sosVals), sosMax = Math.max(...sosVals);
  const streaks  = computeStreaks();

  const sumRows = sorted.map(name => {
    const t = ss[name];
    const n = t.scores.length;
    if (!n) return "";
    const best    = t.scores.reduce((a, b) => b.score > a.score ? b : a);
    const worst   = t.scores.reduce((a, b) => b.score < a.score ? b : a);
    const sosVal  = sos[name] || 0;
    const sosT    = (sosVal - sosMin) / (sosMax - sosMin || 1);
    const sosBg   = `hsl(${((1 - sosT) * 120).toFixed(0)}, 60%, 26%)`; // green = easy schedule, red = hard
    const streak  = streaks[name] ? `<span class="streak-badge">${streaks[name]}</span>` : "";
    return `<tr>
      <td class="td-team"><div class="td-team-inner">${smLogoImg(name)}<span title="${name}">${name}</span>${streak}</div></td>
      <td class="sn-medal sn-gold">${t.first}</td>
      <td class="sn-medal sn-silver">${t.second}</td>
      <td class="sn-medal sn-bronze">${t.third}</td>
      <td class="td-pww">${fmtNum(t.totalPww)}</td>
      <td class="td-rank">Wk ${best.week}</td>
      <td class="sn-best">${fmtNum(best.score)}</td>
      <td class="td-rank">Wk ${worst.week}</td>
      <td class="sn-worst">${fmtNum(worst.score)}</td>
      <td>${fmtNum(t.totalPww / n)}</td>
      <td style="background:${sosBg}" title="Avg opponent PWW score — lower means easier schedule">${fmtNum(sosVal)}</td>
    </tr>`;
  }).join("");

  const sumTable = `<table class="stats-table">
    <thead><tr>
      <th class="th-team">Team</th>
      <th title="1st place finishes">1st</th>
      <th title="2nd place finishes">2nd</th>
      <th title="3rd place finishes">3rd</th>
      <th>Total Pts</th>
      <th>Best Wk</th><th>Best Score</th>
      <th>Worst Wk</th><th>Worst Score</th>
      <th>Avg Score</th>
      <th title="Average opponent PWW score — lower = easier schedule (green), higher = harder (red)">Avg Opp</th>
    </tr></thead>
    <tbody>${sumRows}</tbody></table>`;

  // Cumulative stats
  const colRange = {};
  STAT_LABELS.forEach(stat => {
    const vals     = sorted.map(n => ss[n].statCounts[stat] > 0 ? ss[n].statTotals[stat] / ss[n].statCounts[stat] : 0);
    colRange[stat] = { min: Math.min(...vals), max: Math.max(...vals) };
  });

  const csRows = sorted.map(name => {
    const cells = STAT_LABELS.map(stat => {
      const avg          = ss[name].statCounts[stat] > 0 ? ss[name].statTotals[stat] / ss[name].statCounts[stat] : 0;
      const { min, max } = colRange[stat];
      const t            = (avg - min) / (max - min || 1);
      const bg           = `hsl(${(t * 120).toFixed(0)}, 65%, 28%)`;
      return `<td style="background:${bg}">${fmtStat(stat, avg)}</td>`;
    }).join("");
    return `<tr>
      <td class="td-team"><div class="td-team-inner">${smLogoImg(name)}<span title="${name}">${name}</span></div></td>
      ${cells}
    </tr>`;
  }).join("");

  const csTable = `<table class="stats-table">
    <thead><tr>
      <th class="th-team">Team</th>
      ${STAT_LABELS.map(s => `<th>${s}</th>`).join("")}
    </tr></thead>
    <tbody>${csRows}</tbody></table>`;

  // Head-to-head matrix
  const h2h     = computeH2H();
  const h2hRows = sorted.map(rowTeam => {
    const cells = sorted.map(colTeam => {
      if (rowTeam === colTeam) return `<td class="h2h-self">—</td>`;
      const r   = h2h[rowTeam]?.[colTeam];
      if (!r)   return `<td class="h2h-none">–</td>`;
      const cls = r.W > r.L ? "h2h-win" : r.W < r.L ? "h2h-loss" : "h2h-even";
      return `<td class="${cls}" title="${rowTeam} vs ${colTeam}">${r.W}–${r.L}</td>`;
    }).join("");
    return `<tr>
      <td class="td-team h2h-label"><div class="td-team-inner">${smLogoImg(rowTeam)}<span title="${rowTeam}">${shortName(rowTeam)}</span></div></td>
      ${cells}
    </tr>`;
  }).join("");
  const h2hHeaders = sorted.map(n =>
    `<th class="h2h-col-hdr" title="${n}">${smLogoImg(n)}</th>`).join("");
  const h2hTable = `<table class="stats-table h2h-table">
    <thead><tr><th class="th-team"></th>${h2hHeaders}</tr></thead>
    <tbody>${h2hRows}</tbody></table>`;

  // Category win rates heatmap
  const catRates  = computeCatWinRates();
  const cwrRows   = sorted.map(name => {
    const r = catRates[name] || {};
    const cells = STAT_LABELS.map(s => {
      const d = r[s] || { W: 0, L: 0, T: 0 };
      const total = d.W + d.L + d.T;
      if (!total) return `<td>–</td>`;
      const winPct = (d.W + 0.5 * d.T) / total;
      const bg = `hsl(${(winPct * 120).toFixed(0)}, 60%, 26%)`;
      return `<td style="background:${bg}" title="${s}: ${d.W}W-${d.L}L-${d.T}T">${Math.round(winPct * 100)}%</td>`;
    }).join("");
    return `<tr>
      <td class="td-team"><div class="td-team-inner">${smLogoImg(name)}<span title="${name}">${name}</span></div></td>
      ${cells}
    </tr>`;
  }).join("");
  const cwrTable = `<table class="stats-table">
    <thead><tr>
      <th class="th-team">Team</th>
      ${STAT_LABELS.map(s => `<th>${s}</th>`).join("")}
    </tr></thead>
    <tbody>${cwrRows}</tbody></table>`;

  document.getElementById("season-summary").innerHTML          = `<div class="table-wrap">${sumTable}</div>`;
  document.getElementById("season-h2h").innerHTML              = `<div class="table-wrap">${h2hTable}</div>`;
  document.getElementById("season-cat-rates").innerHTML        = `<div class="table-wrap">${cwrTable}</div>`;
  document.getElementById("season-cumulative-stats").innerHTML = `<div class="table-wrap">${csTable}</div>`;
  document.getElementById("season-weekly-results").innerHTML   = wkTable;

  renderLeaguePtsChart();
  renderAllPlay();
}

function teamBg(name) {
  if (!name) return "transparent";
  return `hsl(${teamHue(name)}, 30%, 20%)`;
}

// ── League points relative to average chart ──────────────────────────────────
function computeLeaguePtsData() {
  // Category-level points: win=2, tie=1, loss=0. Average = 12 pts/team/week.
  const cumulative = {};
  const data       = {};
  let completedCount = 0;

  for (const wk of availWeeks) {
    const weekObj = appData.weeks[String(wk)];
    if (!weekObj || weekObj.is_current) continue;
    completedCount++;

    for (const m of weekObj.matchups || []) {
      for (const [team, side] of [[m.t1, "1"], [m.t2, "2"]]) {
        if (!cumulative[team]) { cumulative[team] = 0; data[team] = [{ week: 0, relPts: 0 }]; }
        for (const cat of m.cats) {
          if      (cat === side) cumulative[team] += 2;
          else if (cat === "T")  cumulative[team] += 1;
        }
      }
    }

    const avg = completedCount * 12;
    for (const team of Object.keys(cumulative)) {
      data[team].push({ week: wk, relPts: cumulative[team] - avg });
    }
  }
  return data;
}

function spreadLabels(items, minGap, _yMin, yMax) {
  if (!items.length) return [];
  const arr = items.map(it => ({ ...it })).sort((a, b) => a.y - b.y);
  // Push down from top
  for (let i = 1; i < arr.length; i++) {
    if (arr[i].y < arr[i - 1].y + minGap) arr[i].y = arr[i - 1].y + minGap;
  }
  // If bottom overflows, push everything up
  if (arr[arr.length - 1].y > yMax) {
    arr[arr.length - 1].y = yMax;
    for (let i = arr.length - 2; i >= 0; i--) {
      if (arr[i].y > arr[i + 1].y - minGap) arr[i].y = arr[i + 1].y - minGap;
    }
  }
  return arr;
}

function renderLeaguePtsChart() {
  const data  = computeLeaguePtsData();
  const teams = Object.keys(data);
  if (!teams.length) return;

  // Y range
  let minY = 0, maxY = 0;
  for (const pts of Object.values(data))
    for (const p of pts) { minY = Math.min(minY, p.relPts); maxY = Math.max(maxY, p.relPts); }
  minY = Math.floor((minY - 5) / 10) * 10;
  maxY = Math.ceil( (maxY + 5) / 10) * 10;

  const maxWeek = Math.max(...teams.flatMap(t => data[t].map(p => p.week)));

  // Layout
  const vW = 1060;
  const cl = 48, cr = 800, ct = 28, cb = 430;
  const cW = cr - cl, cH = cb - ct;

  const xS = w  => cl + (w  / maxWeek) * cW;
  const yS = r  => cb - ((r - minY) / (maxY - minY)) * cH;

  // Grid + y-axis labels
  let grid = "";
  for (let y = minY; y <= maxY; y += 10) {
    const yp = yS(y).toFixed(1);
    const isZero = y === 0;
    grid += `<line x1="${cl}" y1="${yp}" x2="${cr}" y2="${yp}"
      stroke="${isZero ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.06)"}"
      stroke-width="${isZero ? 1.5 : 1}"/>
    <text x="${cl - 5}" y="${yp}" text-anchor="end" dominant-baseline="central"
      font-size="10" fill="rgba(255,255,255,0.4)" font-family="sans-serif">${y}</text>`;
  }

  // X-axis labels
  let xLabels = "";
  for (let w = 1; w <= maxWeek; w++) {
    xLabels += `<text x="${xS(w).toFixed(1)}" y="${cb + 14}" text-anchor="middle"
      font-size="10" fill="rgba(255,255,255,0.4)" font-family="sans-serif">${w}</text>`;
  }

  const someSelected = linesSelected.size > 0;
  const sortedTeams  = [...teams].sort((a, b) => {
    const aLast = data[a][data[a].length - 1].relPts;
    const bLast = data[b][data[b].length - 1].relPts;
    return bLast - aLast;
  });

  // Lines
  const lines = sortedTeams.map(name => {
    const hue        = teamHue(name);
    const isSelected = linesSelected.has(name);
    const opacity    = !someSelected ? 0.7 : isSelected ? 1.0 : 0.07;
    const strokeW    = !someSelected ? 1.8 : isSelected ? 3 : 1;
    const pathD      = data[name].map((p, i) =>
      `${i === 0 ? "M" : "L"}${xS(p.week).toFixed(1)},${yS(p.relPts).toFixed(1)}`
    ).join(" ");
    return `<path class="league-line" data-team="${name}" d="${pathD}"
      fill="none" stroke="hsl(${hue},70%,60%)"
      stroke-width="${strokeW}" stroke-opacity="${opacity}"
      stroke-linejoin="round" stroke-linecap="round"
      style="cursor:pointer;transition:stroke-opacity 0.2s"/>`;
  }).join("");

  // Right-side labels with logos, spread to avoid overlap
  const clipDefs = sortedTeams.map(name => {
    const id = "cp-" + name.replace(/\W/g, "_");
    return `<clipPath id="${id}"><circle cx="11" cy="11" r="10"/></clipPath>`;
  }).join("");

  const desiredLabels = sortedTeams.map(name => {
    const last = data[name][data[name].length - 1];
    return { name, y: yS(last.relPts) };
  });
  const placed = spreadLabels(desiredLabels, 22, ct, cb);

  const rightLabelsHtml = placed.map(({ name, y }) => {
    const hue        = teamHue(name);
    const isSelected = linesSelected.has(name);
    const op         = !someSelected || isSelected ? 1 : 0.2;
    const logoUrl    = appData.teams?.[name]?.logo;
    const id         = "cp-" + name.replace(/\W/g, "_");
    const lastPt     = data[name][data[name].length - 1];
    const lineEndX   = xS(lastPt.week).toFixed(1);
    const lineEndY   = yS(lastPt.relPts).toFixed(1);

    const logoElem = logoUrl
      ? `<image href="${logoUrl}" x="${cr + 5}" y="${y - 11}" width="22" height="22" clip-path="url(#${id})"/>`
      : `<circle cx="${cr + 16}" cy="${y}" r="10" fill="hsl(${hue},70%,60%)"/>`;

    return `<g class="league-legend-item" data-team="${name}"
        style="cursor:pointer;opacity:${op}">
      <line x1="${lineEndX}" y1="${lineEndY}" x2="${cr + 4}" y2="${y.toFixed(1)}"
        stroke="hsl(${hue},70%,60%)" stroke-width="0.8" stroke-opacity="0.35"
        stroke-dasharray="3,2"/>
      ${logoElem}
      <text x="${cr + 30}" y="${y.toFixed(1)}" dominant-baseline="central"
        font-size="10.5" fill="hsl(${hue},75%,72%)"
        font-family="sans-serif" font-weight="600">${shortName(name)}</text>
    </g>`;
  }).join("");

  const svgH = cb + 25;
  const container = document.getElementById("season-lines-chart");
  container.innerHTML = `<svg viewBox="0 0 ${vW} ${svgH}"
    xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block">
    <defs>${clipDefs}</defs>
    <text x="${cl + cW / 2}" y="14" text-anchor="middle" font-size="12"
      fill="rgba(255,255,255,0.45)" font-family="sans-serif">
      Cumulative League Points Relative to Par (avg = 12 pts/week)
    </text>
    ${grid}
    ${xLabels}
    <text x="${cl + cW / 2}" y="${cb + 28}" text-anchor="middle" font-size="11"
      fill="rgba(255,255,255,0.3)" font-family="sans-serif">Week</text>
    ${lines}
    ${rightLabelsHtml}
  </svg>`;

  container.querySelectorAll(".league-line, .league-legend-item").forEach(el => {
    el.addEventListener("click", () => {
      const name = el.dataset.team;
      if (linesSelected.has(name)) linesSelected.delete(name);
      else linesSelected.add(name);
      renderLeaguePtsChart();
    });
  });
}

// ── All-play standings ───────────────────────────────────────────────────────
// Computation lives in allplay.js (shared with tests/allplay.test.js).
let apView = "luck";     // "luck" | "schedule"
let apLive = false;      // include the week in progress
let apLast = null;

function initAllPlayControls() {
  document.querySelectorAll(".ap-seg-btn").forEach(btn => btn.addEventListener("click", () => {
    apView = btn.dataset.view;
    document.querySelectorAll(".ap-seg-btn").forEach(b => {
      b.classList.toggle("ap-seg-active", b === btn);
      b.setAttribute("aria-pressed", String(b === btn));
    });
    renderAllPlayChart(apLast);
  }));
  const live = document.getElementById("ap-live");
  if (live) live.addEventListener("change", () => { apLive = live.checked; renderAllPlay(); });
  let t = null;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(() => { if (activeTab === "season" && apLast) renderAllPlayChart(apLast); }, 150);
  });
}

function renderAllPlay() {
  if (typeof AllPlay === "undefined") return;
  const hasLive = availWeeks.some(w => appData.weeks[String(w)].is_current);
  document.getElementById("ap-live-wrap").hidden = !hasLive;
  apLast = AllPlay.compute(appData.weeks, { includeCurrent: apLive && hasLive });
  renderAllPlayChart(apLast);
  renderAllPlayTable(apLast);
}

const apEsc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const apPct = v => v == null ? "–" : Math.round(v * 100) + "%";
const apRec = r => `${r.W}-${r.L}-${r.T}`;
const apDelta = d => d == null ? "–" : (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d * 100).toFixed(1);
// short chart label: no emoji, at most `max` characters (14 on desktop, 11 on phones)
const apLabel = (name, max = 14) => {
  const s = String(name).replace(/[^\p{L}\p{N}'’ .&-]/gu, "").replace(/\s+/g, " ").trim() || String(name);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};
const apInitials = name => apLabel(name).split(" ").filter(Boolean).map(w => w[0]).slice(0, 2).join("").toUpperCase();

function renderAllPlayChart(res) {
  const box = document.getElementById("ap-chart");
  const legend = document.getElementById("ap-legend");
  if (!box) return;
  if (!res || !res.rows.length) {
    box.innerHTML = `<p class="ap-note" style="text-align:center;padding:24px 0">No finished weeks yet. Tick “Include this week so far” to see the week in progress.</p>`;
    legend.innerHTML = "";
    return;
  }

  const luck  = apView === "luck";
  const phone = (box.clientWidth || 600) < 480;
  // Square plot, same scale on both axes; padded past 0% and 100% so edge markers fit.
  const P = phone ? 300 : 440, L = phone ? 40 : 50, R = 14, T = 12, B = phone ? 40 : 44;
  const W = L + P + R, H = T + P + B;
  const lo = -0.06, hi = 1.06;
  const xs = v => L + (v - lo) / (hi - lo) * P;
  const ys = v => T + P - (v - lo) / (hi - lo) * P;
  const rad = phone ? 9 : 11;
  const fs  = phone ? 9.5 : 10.5;
  const step = phone ? 0.2 : 0.1;

  // zones
  const x0 = L, x1 = L + P, y0 = T, y1 = T + P;
  const zone = (pts, col) => `<polygon points="${pts.map(p => p.join(",")).join(" ")}" style="fill:var(${col});fill-opacity:0.09"/>`;
  let zones, ref;
  if (luck) {
    // y = x runs corner to corner because both axes share one scale
    zones = zone([[x0, y1], [x0, y0], [x1, y0]], "--win") + zone([[x0, y1], [x1, y1], [x1, y0]], "--loss");
    ref = `<line class="ap-ref" x1="${x0}" y1="${y1}" x2="${x1}" y2="${y0}"/>`;
  } else {
    const y50 = ys(0.5);
    zones = zone([[x0, y0], [x1, y0], [x1, y50], [x0, y50]], "--loss") + zone([[x0, y50], [x1, y50], [x1, y1], [x0, y1]], "--win");
    ref = `<line class="ap-ref" x1="${x0}" y1="${y50}" x2="${x1}" y2="${y50}"/>`;
  }

  // grid and ticks
  let grid = "";
  for (let v = 0; v <= 1.0001; v += step) {
    const gx = xs(v).toFixed(1), gy = ys(v).toFixed(1), lab = Math.round(v * 100) + "%";
    grid += `<line class="ap-grid" x1="${gx}" y1="${y0}" x2="${gx}" y2="${y1}"/>
      <line class="ap-grid" x1="${x0}" y1="${gy}" x2="${x1}" y2="${gy}"/>
      <text class="ap-tick" x="${gx}" y="${y1 + 14}" text-anchor="middle">${lab}</text>
      <text class="ap-tick" x="${x0 - 5}" y="${gy}" text-anchor="end" dominant-baseline="central">${lab}</text>`;
  }
  const yTitle = luck ? "Actual win %" : "Opp all-play %";
  const titles = `<text class="ap-axis-title" x="${L + P / 2}" y="${H - 6}" text-anchor="middle">All-play win %</text>
    <text class="ap-axis-title" transform="translate(${phone ? 10 : 12},${T + P / 2}) rotate(-90)" text-anchor="middle">${yTitle}</text>`;

  // points; fan out teams that land on (nearly) the same spot
  const yv = r => luck ? r.actPct : r.oppAll;
  const pts = res.rows.filter(r => yv(r) != null).map(r => ({ r, x: xs(r.allPct), y: ys(yv(r)) }));
  const clusters = [];
  for (const p of pts) {
    const c = clusters.find(c => Math.hypot(c.x - p.x, c.y - p.y) < rad * 1.3);
    if (c) c.items.push(p); else clusters.push({ x: p.x, y: p.y, items: [p] });
  }
  for (const c of clusters) {
    const k = c.items.length;
    if (k < 2) continue;
    const d = rad * (k === 2 ? 1.05 : k <= 4 ? 1.35 : 1.7);
    c.items.forEach((p, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / k;
      p.x = Math.min(x1 + rad, Math.max(x0 - rad, c.x + Math.cos(a) * d));
      p.y = Math.min(y1 + rad, Math.max(y0 - rad, c.y + Math.sin(a) * d));
    });
  }

  // labels: right, left, above, below - first spot that is clear; else no label
  const boxes = pts.map(p => [p.x - rad, p.y - rad, p.x + rad, p.y + rad]);
  const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const placed = [];
  const labels = pts.map((p, i) => {
    const text = apLabel(p.r.team, phone ? 11 : 14), w = text.length * fs * 0.56, h = fs + 2;
    const opts = [
      [p.x + rad + 3, p.y - h / 2, "start"],
      [p.x - rad - 3 - w, p.y - h / 2, "start"],
      [p.x - w / 2, p.y - rad - 3 - h, "start"],
      [p.x - w / 2, p.y + rad + 3, "start"],
    ];
    for (const [lx, ly] of opts) {
      const bx = [lx, ly, lx + w, ly + h];
      if (bx[0] < x0 || bx[2] > x1 + R || bx[1] < y0 - 4 || bx[3] > y1) continue;
      if (placed.some(b => hit(b, bx))) continue;
      if (boxes.some((b, j) => j !== i && hit(b, bx))) continue;
      placed.push(bx);
      return `<text class="ap-label" x="${lx.toFixed(1)}" y="${(ly + h / 2).toFixed(1)}" dominant-baseline="central">${apEsc(text)}</text>`;
    }
    return "";
  }).join("");

  const defs = pts.map((p, i) => `<clipPath id="apc-${i}"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${rad}"/></clipPath>`).join("");
  const marks = pts.map((p, i) => {
    const r = p.r, logo = appData.teams?.[r.team]?.logo;
    const face = logo
      ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${rad}" style="fill:var(--surface-2)"/>
         <image href="${apEsc(logo)}" x="${(p.x - rad).toFixed(1)}" y="${(p.y - rad).toFixed(1)}" width="${rad * 2}" height="${rad * 2}" clip-path="url(#apc-${i})" preserveAspectRatio="xMidYMid slice"/>`
      : `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${rad}" fill="hsl(${teamHue(r.team)},60%,60%)"/>
         <text class="ap-ini" x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle" dominant-baseline="central">${apEsc(apInitials(r.team))}</text>`;
    const tip = `${r.team}: actual ${apRec(r.actual)} (${apPct(r.actPct)}), all-play ${apRec(r.all)} (${apPct(r.allPct)}), Δ ${apDelta(r.delta)}, opp all-play ${apPct(r.oppAll)}`;
    return `<g class="ap-pt" tabindex="0" data-i="${i}"><title>${apEsc(tip)}</title>${face}<circle class="ap-ring" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${rad}"/></g>`;
  }).join("");

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img"
      aria-label="${luck ? "All-play win % against actual win %" : "All-play win % against opponents' all-play %"}">
    <defs>${defs}</defs>${zones}${grid}${ref}${labels}${marks}${titles}</svg>
    <div class="ap-tip" id="ap-tip" hidden></div>`;

  // hover / tap / keyboard: exact numbers
  const tipEl = document.getElementById("ap-tip");
  const show = g => {
    const p = pts[Number(g.dataset.i)], r = p.r, sc = box.clientWidth / W;
    tipEl.innerHTML = `<b>${apEsc(r.team)}</b>
      Actual <span>${apRec(r.actual)} · ${apPct(r.actPct)}</span><br>
      All-play <span>${apRec(r.all)} · ${apPct(r.allPct)}</span><br>
      Δ Win% <span>${apDelta(r.delta)}</span> · Opp all-play <span>${apPct(r.oppAll)}</span>`;
    tipEl.hidden = false;
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let left = p.x * sc + rad * sc + 8, top = p.y * sc - th / 2;
    if (left + tw > box.clientWidth) left = p.x * sc - rad * sc - 8 - tw;
    tipEl.style.left = Math.max(0, left) + "px";
    tipEl.style.top = Math.max(0, Math.min(box.clientHeight - th, top)) + "px";
  };
  const hide = () => { tipEl.hidden = true; };
  box.querySelectorAll(".ap-pt").forEach(g => {
    g.addEventListener("mouseenter", () => show(g));
    g.addEventListener("focus", () => show(g));
    g.addEventListener("click", () => show(g));
    g.addEventListener("mouseleave", hide);
    g.addEventListener("blur", hide);
  });

  legend.innerHTML = luck
    ? `<span><i class="ap-sw" style="background:color-mix(in srgb, var(--win) 22%, transparent)"></i>Lucky: record beats play</span>
       <span><i class="ap-sw" style="background:color-mix(in srgb, var(--loss) 22%, transparent)"></i>Unlucky: record trails play</span>
       <span><i class="ap-sw-line"></i>Record matches play</span>`
    : `<span><i class="ap-sw" style="background:color-mix(in srgb, var(--loss) 22%, transparent)"></i>Tough schedule</span>
       <span><i class="ap-sw" style="background:color-mix(in srgb, var(--win) 22%, transparent)"></i>Soft schedule</span>
       <span><i class="ap-sw-line"></i>50% = average opponent</span>`;
}

function renderAllPlayTable(res) {
  const el = document.getElementById("ap-table");
  if (!el) return;
  if (!res || !res.rows.length) { el.innerHTML = ""; return; }
  // subtle tint: green = lucky / soft schedule, red = unlucky / tough
  const tint = (v, full) => {
    if (v == null || Math.abs(v) < 0.005) return "";
    const a = Math.round(Math.min(1, Math.abs(v) / full) * 30);
    return `background:color-mix(in srgb, var(${v > 0 ? "--loss" : "--win"}) ${a}%, transparent)`;
  };
  const rows = res.rows.map(r => `<tr>
      <td class="ap-rank">${r.rank}</td>
      <td class="td-team"><div class="td-team-inner">${smLogoImg(r.team)}<span title="${apEsc(r.team)}">${apEsc(r.team)}</span></div></td>
      <td class="ap-num">${r.actPct == null ? "–" : apRec(r.actual)}<small>${apPct(r.actPct)}</small></td>
      <td class="ap-num">${apRec(r.all)}<small>${apPct(r.allPct)}</small></td>
      <td class="ap-num" style="${tint(r.delta, 0.35)}" title="All-play % minus actual %: positive = unlucky">${apDelta(r.delta)}</td>
      <td class="ap-num" style="${tint(r.oppAll == null ? null : r.oppAll - 0.5, 0.25)}" title="Average all-play % of your opponents in the weeks they played you">${apPct(r.oppAll)}</td>
    </tr>`).join("");
  const ws = res.weeks, cur = ws.filter(w => appData.weeks[String(w)]?.is_current);
  const span = ws.length ? (ws.length > 1 ? `Weeks ${ws[0]}–${ws[ws.length - 1]}` : `Week ${ws[0]}`) : "";
  el.innerHTML = `<table class="stats-table ap-table">
      <thead><tr>
        <th class="th-rank">#</th><th class="th-team">Team</th>
        <th title="Real weekly matchup results">Actual</th>
        <th title="Every week against all 11 other teams">All-play</th>
        <th title="All-play % minus actual %, in percentage points. Positive = unlucky">Δ Win%</th>
        <th title="Strength of schedule: average all-play % of your opponents the week they played you. Above 50% = tough">Opp all-play</th>
      </tr></thead><tbody>${rows}</tbody></table>
    <p class="ap-note">${span}${cur.length ? ` (week ${cur[0]} so far)` : ""}. Ranked by all-play %. A matchup is won by winning more categories; ties count as half.</p>`;
}

// ── Logo helpers ─────────────────────────────────────────────────────────────
function logoImg(teamName, cls, size) {
  const url = appData.teams?.[teamName]?.logo;
  if (url) {
    return `<img class="${cls}" src="${url}" alt="${teamName}"
              width="${size}" height="${size}"
              onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
            ><div class="${cls}-ph" style="width:${size}px;height:${size}px;display:none;border-radius:50%;background:var(--surface-2);border:2px solid var(--border);align-items:center;justify-content:center;font-size:${Math.round(size*0.45)}px">🏒</div>`;
  }
  return `<div class="${cls}-ph" style="width:${size}px;height:${size}px;display:flex;border-radius:50%;background:var(--surface-2);border:2px solid var(--border);align-items:center;justify-content:center;font-size:${Math.round(size*0.45)}px">🏒</div>`;
}

function smLogoImg(teamName) {
  const url = appData.teams?.[teamName]?.logo;
  if (url) return `<img class="bar-sm-logo" src="${url}" alt="${teamName}" width="22" height="22">`;
  return `<div class="bar-sm-logo-ph">🏒</div>`;
}

// ── Format helpers ────────────────────────────────────────────────────────────
function fmtStat(label, val) {
  if (val === undefined || val === null) return "-";
  if (label === "SV%") return Number(val).toFixed(3).replace(/^0/, "");
  return Number.isInteger(Number(val)) ? String(Math.round(val)) : Number(val).toFixed(1);
}

function fmtNum(n) {
  return Math.round(n).toLocaleString();
}

function shortName(name) {
  return name.length > 16 ? name.slice(0, 15) + "\u2026" : name;
}

function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-AU", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", timeZone: "Australia/Brisbane",
  });
}

function show(id) {
  ["loading", "error", "content"].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.hidden = (s !== id);
  });
}

init();
