/* allplay.js — All-play standings (pure computation, no DOM).
 *
 * Loaded by the page as a plain script (defines window.AllPlay) and by
 * tests/allplay.test.js under Node (module.exports).
 *
 * Definitions (matchup level, like Yahoo's standings):
 *   pairing        won by whoever wins more of the 12 categories (SV% compared as the rate
 *                  it is stored as); equal category counts = a tied pairing.
 *   actual record  each team's real weekly matchups (W-L-T), from week.matchups.
 *   all-play       every counted week, each team against all 11 others (11 "games" a week).
 *   win %          (W + 0.5*T) / (W + L + T).
 *   delta          all-play % minus actual %. Positive = unlucky (record worse than play).
 *   opp all-play   average of each opponent's all-play % in the week they played you.
 *                  Above 50% = tough schedule.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AllPlay = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CATS = ["G", "A", "PIM", "PPP", "SOG", "FW", "HIT", "BLK", "W", "SV", "SV%", "SHO"];

  const pct = r => {
    const n = r.W + r.L + r.T;
    return n ? (r.W + 0.5 * r.T) / n : null;
  };

  /** "1" if a wins the pairing on categories, "2" if b does, "T" if level. */
  function pairing(statsA, statsB, cats) {
    let a = 0, b = 0;
    for (const c of cats) {
      const va = Number(statsA[c]) || 0, vb = Number(statsB[c]) || 0;
      if (va > vb) a++;
      else if (vb > va) b++;
    }
    return a > b ? "1" : b > a ? "2" : "T";
  }

  /** Pairing result from a stored matchup's per-category results ("1"/"2"/"T"). */
  function matchupResult(cats) {
    const a = cats.filter(c => c === "1").length;
    const b = cats.filter(c => c === "2").length;
    return a > b ? "1" : b > a ? "2" : "T";
  }

  /**
   * weeks: { "1": {is_current, stats: {team: {G:..}}, matchups: [{t1, t2, cats}]}, ... }
   * opts.includeCurrent: count the in-progress week too (default false: finished weeks only).
   */
  function compute(weeks, opts) {
    const o = Object.assign({ includeCurrent: false, cats: CATS }, opts || {});
    const rec = {};
    const get = t => rec[t] || (rec[t] = {
      actual: { W: 0, L: 0, T: 0 }, all: { W: 0, L: 0, T: 0 }, oppSum: 0, oppN: 0,
    });
    const used = [];

    const keys = Object.keys(weeks || {}).map(Number).sort((a, b) => a - b);
    for (const w of keys) {
      const wk = weeks[String(w)];
      if (!wk || !wk.stats) continue;
      if (wk.is_current && !o.includeCurrent) continue;
      const teams = Object.keys(wk.stats);
      if (teams.length < 2) continue;
      used.push(w);

      // all-play: every pair once
      const weekRec = {};
      teams.forEach(t => { weekRec[t] = { W: 0, L: 0, T: 0 }; get(t); });
      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const a = teams[i], b = teams[j];
          const r = pairing(wk.stats[a], wk.stats[b], o.cats);
          if (r === "1") { weekRec[a].W++; weekRec[b].L++; }
          else if (r === "2") { weekRec[a].L++; weekRec[b].W++; }
          else { weekRec[a].T++; weekRec[b].T++; }
        }
      }
      const weekPct = {};
      for (const t of teams) {
        const r = weekRec[t], all = rec[t].all;
        all.W += r.W; all.L += r.L; all.T += r.T;
        weekPct[t] = pct(r);
      }

      // actual matchups and strength of schedule
      for (const m of wk.matchups || []) {
        if (!m || !m.t1 || !m.t2 || !Array.isArray(m.cats)) continue;
        const r = matchupResult(m.cats);
        const a = get(m.t1).actual, b = get(m.t2).actual;
        if (r === "1") { a.W++; b.L++; }
        else if (r === "2") { a.L++; b.W++; }
        else { a.T++; b.T++; }
        if (weekPct[m.t2] != null) { rec[m.t1].oppSum += weekPct[m.t2]; rec[m.t1].oppN++; }
        if (weekPct[m.t1] != null) { rec[m.t2].oppSum += weekPct[m.t1]; rec[m.t2].oppN++; }
      }
    }

    const rows = Object.keys(rec).map(team => {
      const r = rec[team];
      const actPct = pct(r.actual), allPct = pct(r.all);
      return {
        team,
        actual: r.actual, all: r.all,
        actPct, allPct,
        delta: (actPct != null && allPct != null) ? allPct - actPct : null,
        oppAll: r.oppN ? r.oppSum / r.oppN : null,
      };
    }).filter(r => r.allPct != null);

    rows.sort((a, b) => (b.allPct - a.allPct) || ((b.actPct ?? 0) - (a.actPct ?? 0)) || a.team.localeCompare(b.team));
    rows.forEach((r, i) => { r.rank = i + 1; });
    return { rows, weeks: used };
  }

  return { compute, pairing, matchupResult, pct, CATS };
}));
