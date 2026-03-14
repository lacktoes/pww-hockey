/* app.js — PWW Hockey Dashboard */

const STAT_LABELS  = ["G","A","PIM","PPP","SOG","FW","HIT","BLK","W","SV","SV%","SHO"];
const CAT_WEIGHTS  = [100,100,100,100,100,100,100,100,100,100,100,50];

// One visually distinct colour per category (evenly spaced hues)
const CAT_COLORS = {};
STAT_LABELS.forEach((s, i) => { CAT_COLORS[s] = `hsl(${i * 30}, 70%, 55%)`; });

let appData      = null;
let selectedWeek = null;
let availWeeks   = [];

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch("data.json");
    if (!res.ok) throw new Error(res.statusText);
    appData    = await res.json();
    availWeeks = Object.keys(appData.weeks).map(Number).sort((a, b) => a - b);
    selectWeek(appData.meta.current_week);
  } catch (e) {
    show("error");
  }
}

function selectWeek(week) {
  selectedWeek = week;
  renderWeek(week);
  updateNav();
}

// ── Navigation ─────────────────────────────────────────────────────────────
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
  const idx = availWeeks.indexOf(selectedWeek);
  if (e.key === "ArrowLeft"  && idx > 0)                   selectWeek(availWeeks[idx - 1]);
  if (e.key === "ArrowRight" && idx < availWeeks.length-1) selectWeek(availWeeks[idx + 1]);
});

// ── Render a week ──────────────────────────────────────────────────────────
function renderWeek(week) {
  const wk = appData.weeks[String(week)];

  document.getElementById("week-label").textContent = "Week " + week;
  document.getElementById("live-badge").hidden      = !wk.is_current;
  document.getElementById("last-updated").textContent =
    "Updated " + fmtDate(appData.meta.last_updated);

  // Compute per-category normalised scores (needed for bars + table)
  const catContribs = computeCatContribs(wk);

  document.getElementById("podium-container").innerHTML    = renderPodium(wk);
  renderStackedBars(wk, catContribs);
  document.getElementById("stats-table").innerHTML         = renderStatsTable(wk, catContribs);
  document.getElementById("matchups-container").innerHTML  = renderMatchups(wk);
  document.getElementById("leaders-container").innerHTML   = renderLeaders(wk);

  show("content");
}

// ── Per-category normalised score breakdown ────────────────────────────────
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

// ── 1. Podium ───────────────────────────────────────────────────────────────
function renderPodium(wk) {
  const board = wk.leaderboard || [];
  if (board.length < 3) return "<p style='color:var(--text-2);text-align:center'>Not enough data</p>";

  const medals    = ["🥇", "🥈", "🥉"];
  const posClass  = ["first", "second", "third"];
  const blockCls  = ["first", "second", "third"];
  // Display order: 2nd (left), 1st (centre), 3rd (right)
  const order     = [1, 0, 2];

  return order.map(rank => {
    const name   = board[rank];
    const score  = (wk.pww[name] || 0).toFixed(1);
    const record = appData.standings?.[name];
    const rec    = record ? record.W + "W - " + record.L + "L" + (record.T ? " - " + record.T + "T" : "") : "";
    const pos    = posClass[rank];
    const bk     = blockCls[rank];

    return `
    <div class="podium-slot podium-${pos}">
      <div class="podium-info">
        ${logoImg(name, "podium-logo", pos === "first" ? 90 : pos === "second" ? 72 : 64)}
        <div class="podium-medal">${medals[rank]}</div>
        <div class="podium-name" title="${name}">${name}</div>
        <div class="podium-score">${score}</div>
        ${rec ? `<div class="podium-record">${rec}</div>` : ""}
      </div>
      <div class="podium-block podium-block-${bk}">${rank + 1}</div>
    </div>`;
  }).join("");
}

// ── 2. Stacked bar chart ────────────────────────────────────────────────────
function renderStackedBars(wk, catContribs) {
  const board    = wk.leaderboard || [];
  const maxScore = wk.pww[board[0]] || 1;

  const barsHtml = board.map(name => {
    const total  = wk.pww[name] || 0;
    const widPct = (total / maxScore * 100).toFixed(1);

    const segs = STAT_LABELS.map(stat => {
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
      <div class="bar-track" style="max-width:calc(${widPct}% - 200px)">
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

// ── 3. Stats heatmap table ──────────────────────────────────────────────────
function renderStatsTable(wk) {
  const board = wk.leaderboard || [];

  // Compute min/max per column for heatmap colouring
  const colRange = {};
  STAT_LABELS.forEach(stat => {
    const vals       = board.map(t => Number(wk.stats[t]?.[stat]) || 0);
    colRange[stat]   = { min: Math.min(...vals), max: Math.max(...vals) };
  });

  const header = `<thead><tr>
    <th class="th-rank">#</th>
    <th class="th-team">Team</th>
    <th class="th-pww">PWW</th>
    ${STAT_LABELS.map(s => `<th>${s}</th>`).join("")}
  </tr></thead>`;

  const rows = board.map((name, i) => {
    const pww   = (wk.pww[name] || 0).toFixed(1);
    const cells = STAT_LABELS.map(stat => {
      const raw  = wk.stats[name]?.[stat];
      const num  = Number(raw) || 0;
      const { min, max } = colRange[stat];
      const t    = (num - min) / (max - min || 1);
      // HSL: 0=red, 60=yellow, 120=green — dark enough for white text
      const bg   = `hsl(${(t * 120).toFixed(0)}, 65%, 28%)`;
      return `<td style="background:${bg}">${fmtStat(stat, raw)}</td>`;
    }).join("");

    return `<tr>
      <td class="td-rank">${i + 1}</td>
      <td class="td-team">
        <div class="td-team-inner">
          ${smLogoImg(name)}
          <span title="${name}">${name}</span>
        </div>
      </td>
      <td class="td-pww">${pww}</td>
      ${cells}
    </tr>`;
  }).join("");

  return header + `<tbody>${rows}</tbody>`;
}

// ── 4. Matchups ─────────────────────────────────────────────────────────────
function renderMatchups(wk) {
  return wk.matchups.map(m => {
    const t1     = m.t1, t2 = m.t2;
    const pww1   = wk.pww[t1] ?? 0, pww2 = wk.pww[t2] ?? 0;
    const win1   = pww1 >= pww2,    win2 = pww2 > pww1;
    const stats1 = wk.stats[t1] ?? {}, stats2 = wk.stats[t2] ?? {};

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
            <div class="team-pww">${pww1.toFixed(1)}</div>
          </div>
        </div>
        <div class="matchup-vs">PWW</div>
        <div class="team-side team-side--right ${win2 ? "winning" : ""}">
          <div class="team-info">
            <div class="team-name" title="${t2}">${t2}</div>
            <div class="team-pww">${pww2.toFixed(1)}</div>
          </div>
          ${logoImg(t2, "team-logo", 42)}
        </div>
      </div>
      <div class="cat-strip">${pills}</div>
    </div>`;
  }).join("");
}

// ── 5. Category leaders ─────────────────────────────────────────────────────
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

// ── Logo helpers ────────────────────────────────────────────────────────────
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

// ── Formatting helpers ──────────────────────────────────────────────────────
function fmtStat(label, val) {
  if (val === undefined || val === null) return "-";
  if (label === "SV%") return Number(val).toFixed(3).replace(/^0/, "");
  return Number.isInteger(Number(val)) ? String(Math.round(val)) : Number(val).toFixed(1);
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
