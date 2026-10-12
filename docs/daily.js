/* daily.js — league position day by day (pure computation, no DOM).
 *
 * Loaded by the page as a plain script (defines window.DailyRace) and by
 * tests/daily.test.js under Node (module.exports).
 *
 * League points are Yahoo's category points: 2 for a category won, 1 for a tie, 0 for a
 * loss (24 per matchup, so 12 a week is par). For each day:
 *   points = everything from earlier finished weeks
 *          + this week's matchup scored on the totals built up through that day.
 * The last day of a FINISHED week uses Yahoo's official category results (week.matchups),
 * so rules the totals can't show, like the goalie-minimum forfeit, land on that day and the
 * line ends exactly where the standings do.
 *
 * week.daily = { cols: ["G", ..., "SV", "SA", ..., "GP"], days: { "2026-10-05": { team: [..] } } }
 * (written by scripts/fetch_data.py). SV% is derived from SV / SA, never summed.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DailyRace = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CATS = ["G", "A", "PIM", "PPP", "SOG", "FW", "HIT", "BLK", "W", "SV", "SV%", "SHO"];

  const val = (tot, c) => {
    if (c !== "SV%") return tot[c] || 0;
    return tot.SA > 0 ? tot.SV / tot.SA : -1;      // no shots faced loses SV% to anyone who has
  };

  /** Per-category result on running totals: "1", "2" or "T". */
  function catsOn(a, b) {
    return CATS.map(c => {
      const va = val(a, c), vb = val(b, c);
      return va > vb ? "1" : vb > va ? "2" : "T";
    });
  }

  /** [points, category wins] for each side of a per-category result. */
  function score(cats) {
    let p1 = 0, p2 = 0, w1 = 0, w2 = 0;
    for (const c of cats) {
      if (c === "1") { p1 += 2; w1++; }
      else if (c === "2") { p2 += 2; w2++; }
      else { p1++; p2++; }
    }
    return [[p1, w1], [p2, w2]];
  }

  function compute(weeks) {
    const keys = Object.keys(weeks || {}).map(Number).sort((a, b) => a - b);
    const teams = [];
    const seen = new Set();
    const note = t => { if (!seen.has(t)) { seen.add(t); teams.push(t); } };
    for (const w of keys) Object.keys((weeks[String(w)] || {}).stats || {}).forEach(note);

    const base = {};                       // [points, wins] banked from finished weeks
    teams.forEach(t => { base[t] = [0, 0]; });
    const days = [];                       // { date, week, live, final, pts: {team: n}, wins: {team: n} }

    const push = (date, week, wk, final, inWeek) => {
      const pts = {}, wins = {};
      for (const t of teams) {
        const add = inWeek[t] || [0, 0];
        pts[t] = base[t][0] + add[0];
        wins[t] = base[t][1] + add[1];
      }
      days.push({ date, week, live: !!wk.is_current, final, pts, wins });
    };

    for (const w of keys) {
      const wk = weeks[String(w)];
      if (!wk) continue;
      const ms = (wk.matchups || []).filter(m => m && m.t1 && m.t2 && Array.isArray(m.cats));
      const official = {};
      for (const m of ms) {
        const [a, b] = score(m.cats);
        official[m.t1] = a; official[m.t2] = b;
      }

      const daily = wk.daily && wk.daily.days ? wk.daily : null;
      const dates = daily ? Object.keys(daily.days).sort() : [];
      if (!dates.length) {
        // no day-by-day totals for this week: one point, at its end
        if (!wk.is_current) push(wk.week_end || null, w, wk, true, official);
      } else {
        const cols = daily.cols || [];
        const run = {};
        dates.forEach((date, i) => {
          const row = daily.days[date] || {};
          for (const t of Object.keys(row)) {
            const tot = run[t] || (run[t] = {});
            cols.forEach((c, j) => { tot[c] = (tot[c] || 0) + (Number(row[t][j]) || 0); });
          }
          const last = i === dates.length - 1;
          const final = last && !wk.is_current;
          let inWeek = official;
          if (!final) {
            inWeek = {};
            for (const m of ms) {
              const [a, b] = score(catsOn(run[m.t1] || {}, run[m.t2] || {}));
              inWeek[m.t1] = a; inWeek[m.t2] = b;
            }
          }
          push(date, w, wk, final, inWeek);
        });
      }

      if (!wk.is_current) {
        for (const t of Object.keys(official)) {
          if (!base[t]) base[t] = [0, 0];
          base[t][0] += official[t][0]; base[t][1] += official[t][1];
        }
      }
    }

    // Rank each day: points, then category wins, then yesterday's order (so level teams
    // don't swap places for no reason), then name.
    let prev = {};
    for (const d of days) {
      const order = [...teams].sort((a, b) =>
        (d.pts[b] - d.pts[a]) || (d.wins[b] - d.wins[a]) ||
        ((prev[a] ?? 99) - (prev[b] ?? 99)) || a.localeCompare(b));
      d.rank = {};
      order.forEach((t, i) => { d.rank[t] = i + 1; });
      const avg = teams.reduce((s, t) => s + d.pts[t], 0) / (teams.length || 1);
      d.rel = {};
      teams.forEach(t => { d.rel[t] = d.pts[t] - avg; });
      prev = d.rank;
    }
    return { teams, days };
  }

  return { compute, catsOn, score, CATS };
}));
