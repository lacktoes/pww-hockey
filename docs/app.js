/* app.js — PWW Hockey Dashboard */

const STAT_LABELS = ["G","A","PIM","PPP","SOG","FW","HIT","BLK","W","SV","SV%","SHO"];

let appData      = null;   // full data.json
let selectedWeek = null;
let availWeeks   = [];

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch("data.json");
    if (!res.ok) throw new Error(res.statusText);
    appData    = await res.json();
    availWeeks = (appData.meta.available_weeks || Object.keys(appData.weeks).map(Number)).sort((a,b)=>a-b);
    if (!availWeeks.length) {
      // derive from weeks keys
      availWeeks = Object.keys(appData.weeks).map(Number).sort((a,b)=>a-b);
    }
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
  if (!availWeeks.length) return;
  const idx = availWeeks.indexOf(selectedWeek);
  if (e.key === "ArrowLeft"  && idx > 0)                   selectWeek(availWeeks[idx - 1]);
  if (e.key === "ArrowRight" && idx < availWeeks.length-1) selectWeek(availWeeks[idx + 1]);
});

// ── Render a week ──────────────────────────────────────────────────────────
function renderWeek(week) {
  const wk   = appData.weeks[String(week)];
  const meta = appData.meta;

  // Header
  const isCurrent = wk.is_current;
  document.getElementById("week-label").textContent = `Week ${week}`;
  const liveBadge = document.getElementById("live-badge");
  liveBadge.hidden = !isCurrent;

  const upd = document.getElementById("last-updated");
  upd.textContent = `Updated ${fmtDate(meta.last_updated)}`;

  document.getElementById("matchups-container").innerHTML  = renderMatchups(wk);
  document.getElementById("leaderboard-container").innerHTML = renderLeaderboard(wk);
  document.getElementById("leaders-container").innerHTML   = renderLeaders(wk);

  show("content");
}

// ── Matchup cards ──────────────────────────────────────────────────────────
function renderMatchups(wk) {
  return wk.matchups.map(m => {
    const t1     = m.t1,  t2 = m.t2;
    const pww1   = wk.pww[t1] ?? 0,  pww2 = wk.pww[t2] ?? 0;
    const win1   = pww1 >= pww2,      win2 = pww2 > pww1;
    const stats1 = wk.stats[t1] ?? {}, stats2 = wk.stats[t2] ?? {};

    const pills = m.cats.map((c, i) => {
      const label = STAT_LABELS[i];
      const v1 = fmtStat(label, stats1[label]);
      const v2 = fmtStat(label, stats2[label]);
      const cls = c === "1" ? "cat-1" : c === "2" ? "cat-2" : "cat-tie";
      return `<span class="cat-pill ${cls}" title="${label}: ${v1} vs ${v2}">${label}</span>`;
    }).join("");

    return `
    <div class="matchup-card">
      <div class="matchup-teams">
        <div class="team-side ${win1 ? "winning" : ""}">
          ${logoImg(t1, "team-logo", "42")}
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
          ${logoImg(t2, "team-logo", "42")}
        </div>
      </div>
      <div class="cat-strip">${pills}</div>
    </div>`;
  }).join("");
}

// ── Leaderboard ────────────────────────────────────────────────────────────
function renderLeaderboard(wk) {
  const board  = wk.leaderboard || [];
  const maxPww = Math.max(...board.map(n => wk.pww[n] ?? 0), 1);

  return board.map((name, i) => {
    const score = wk.pww[name] ?? 0;
    const delta = wk.deltas?.[name];
    const pct   = (score / maxPww * 100).toFixed(1);
    const record= appData.standings?.[name];
    const recStr= record ? `<span class="lb-record">${record.W}-${record.L}${record.T ? `-${record.T}` : ""}</span>` : "";

    let deltaHtml = "";
    if (delta !== null && delta !== undefined) {
      const cls = delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : "delta-nil";
      const sign = delta > 0 ? "+" : "";
      deltaHtml = `<span class="lb-delta ${cls}">${sign}${delta.toFixed(0)}</span>`;
    } else {
      deltaHtml = `<span class="lb-delta delta-nil">—</span>`;
    }

    return `
    <div class="leaderboard-row">
      <span class="lb-rank">${i + 1}</span>
      ${logoImg(name, "lb-logo", "28")}
      <span class="lb-name" title="${name}">${name} ${recStr}</span>
      <div class="lb-bar-wrap"><div class="lb-bar" style="width:${pct}%"></div></div>
      <span class="lb-score">${score.toFixed(1)}</span>
      ${deltaHtml}
    </div>`;
  }).join("");
}

// ── Category leaders ───────────────────────────────────────────────────────
function renderLeaders(wk) {
  return STAT_LABELS.map(stat => {
    const leader = wk.leaders?.[stat];
    if (!leader) return "";
    const val = wk.stats?.[leader]?.[stat];
    return `
    <div class="leader-tile">
      <div class="leader-stat">${stat}</div>
      ${logoImg(leader, "leader-logo", "34")}
      <div class="leader-team" title="${leader}">${shortName(leader)}</div>
      <div class="leader-value">${fmtStat(stat, val)}</div>
    </div>`;
  }).join("");
}

// ── Helpers ────────────────────────────────────────────────────────────────
function logoImg(teamName, cls, size) {
  const teamObj = appData.teams?.[teamName];
  const url     = teamObj?.logo;
  if (url) {
    return `<img class="${cls}" src="${url}" alt="${teamName}"
              onerror="this.outerHTML=placeholder(${size})"
              width="${size}" height="${size}">`;
  }
  return `<div class="${cls}-placeholder" style="width:${size}px;height:${size}px">🏒</div>`;
}

function placeholder(size) {
  // called via onerror inline — returns HTML string
  return `\`<div class="team-logo-placeholder" style="width:${size}px;height:${size}px">🏒</div>\``;
}

function fmtStat(label, val) {
  if (val === undefined || val === null) return "—";
  if (label === "SV%") return Number(val).toFixed(3).replace(/^0/, "");
  return Number.isInteger(Number(val)) ? String(Math.round(val)) : Number(val).toFixed(1);
}

function shortName(name) {
  // Truncate long team names sensibly
  return name.length > 14 ? name.slice(0, 13) + "…" : name;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-AU", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", timeZone: "Australia/Brisbane",
  });
}

function show(id) {
  ["loading","error","content"].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.hidden = (s !== id);
  });
}

init();
