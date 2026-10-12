/* daily.js — one week's PWW race, day by day (pure computation, no DOM).
 *
 * Loaded by the page as a plain script (defines window.DailyRace) and by
 * tests/daily.test.js under Node (module.exports).
 *
 * For each day of a week, every team's PWW score is recomputed on the totals built up
 * through that day, exactly as the weekly score is: per category, each team's value is
 * scaled between the league's lowest (0) and highest (full weight), and the categories are
 * added up. SV% comes from summed SV / SA, never from averaging daily rates.
 *
 * The last day uses the week's published scores (week.pww), so every line ends exactly on
 * the number shown elsewhere on the page (the weekly SV% is rounded to 3 places, which
 * would otherwise leave a hair's difference).
 *
 * week.daily = { cols: ["G", ..., "SV", "SA", ..., "GP"], days: { "2026-10-05": { team: [..] } } }
 * (written by scripts/fetch_data.py).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DailyRace = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CATS    = ["G", "A", "PIM", "PPP", "SOG", "FW", "HIT", "BLK", "W", "SV", "SV%", "SHO"];
  const WEIGHTS = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 50];

  const val = (tot, c) => {
    if (c !== "SV%") return tot[c] || 0;
    return tot.SA > 0 ? tot.SV / tot.SA : 0;
  };

  /** PWW score per team from a {team: totals} map. */
  function pww(totals, cats, weights) {
    const teams = Object.keys(totals);
    const out = {};
    teams.forEach(t => { out[t] = 0; });
    cats.forEach((c, i) => {
      const vals = teams.map(t => val(totals[t], c));
      const min = Math.min(...vals), range = (Math.max(...vals) - min) || 1;
      teams.forEach((t, k) => { out[t] += ((vals[k] - min) / range) * weights[i]; });
    });
    return out;
  }

  /**
   * week: one entry of data.weeks. Returns { teams, days: [{date, score, rank, final}] },
   * or null when the week has no day-by-day totals.
   */
  function compute(week, opts) {
    const o = Object.assign({ cats: CATS, weights: WEIGHTS }, opts || {});
    const daily = week && week.daily && week.daily.days ? week.daily : null;
    const dates = daily ? Object.keys(daily.days).sort() : [];
    if (!dates.length) return null;

    const cols = daily.cols || [];
    const teams = Object.keys(week.stats || {}).length
      ? Object.keys(week.stats)
      : [...new Set(dates.flatMap(d => Object.keys(daily.days[d] || {})))];
    const run = {};
    teams.forEach(t => { run[t] = {}; });

    const days = [];
    let prev = {};
    dates.forEach((date, i) => {
      const row = daily.days[date] || {};
      for (const t of teams) {
        if (!row[t]) continue;
        cols.forEach((c, j) => { run[t][c] = (run[t][c] || 0) + (Number(row[t][j]) || 0); });
      }
      const last = i === dates.length - 1;
      const published = last && week.pww && teams.every(t => week.pww[t] != null);
      const score = published ? Object.assign({}, week.pww) : pww(run, o.cats, o.weights);
      // Rank: score, then yesterday's order so level teams don't swap for no reason, then name.
      const order = [...teams].sort((a, b) =>
        (score[b] - score[a]) || ((prev[a] ?? 99) - (prev[b] ?? 99)) || a.localeCompare(b));
      const rank = {};
      order.forEach((t, k) => { rank[t] = k + 1; });
      days.push({ date, score, rank, final: last && !week.is_current });
      prev = rank;
    });
    return { teams, days };
  }

  return { compute, pww, CATS, WEIGHTS };
}));
