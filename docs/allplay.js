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
 *   category level the same comparisons counted per category instead of per matchup:
 *                  category share = (categories won + 0.5 * tied) / categories played, i.e.
 *                  the share of the 24 points (2 per category won, 1 per tie) available in
 *                  each matchup. A 12-0 win is 100%, a 5-4-3 win 54.2%. Fields: actCat,
 *                  allCat (W-L-T in categories), actCatPct, allCatPct, deltaCat, oppAllCat.
 *                  The actual side counts Yahoo's stored category results (week.matchups),
 *                  which is what the league's standings are scored on.
 *   goalie minimum a team with fewer than `goalieMin` goalie appearances in a finished week
 *                  forfeits W, SV, SV% and SHO to any opponent that met it, as Yahoo scores
 *                  it (week.goalie_gp, written by fetch_data.py). If both teams fall short,
 *                  those categories are treated as tied. Not applied to a week in progress.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AllPlay = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CATS = ["G", "A", "PIM", "PPP", "SOG", "FW", "HIT", "BLK", "W", "SV", "SV%", "SHO"];
  const GOALIE = new Set(["W", "SV", "SV%", "SHO"]);

  const pct = r => {
    const n = r.W + r.L + r.T;
    return n ? (r.W + 0.5 * r.T) / n : null;
  };

  /** Categories won by a, won by b, and tied.
   *  forfeitA / forfeitB: that team missed the goalie minimum this week. */
  function catCounts(statsA, statsB, cats, forfeitA, forfeitB) {
    let a = 0, b = 0, t = 0;
    for (const c of cats) {
      if (GOALIE.has(c) && (forfeitA || forfeitB)) {
        if (forfeitA && !forfeitB) b++;
        else if (forfeitB && !forfeitA) a++;
        else t++;                      // both short: tied
        continue;
      }
      const va = Number(statsA[c]) || 0, vb = Number(statsB[c]) || 0;
      if (va > vb) a++;
      else if (vb > va) b++;
      else t++;
    }
    return { a, b, t };
  }

  /** "1" if a wins the pairing on categories, "2" if b does, "T" if level. */
  function pairing(statsA, statsB, cats, forfeitA, forfeitB) {
    const { a, b } = catCounts(statsA, statsB, cats, forfeitA, forfeitB);
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
    const o = Object.assign({ includeCurrent: false, cats: CATS, goalieMin: null }, opts || {});
    const rec = {};
    const get = t => rec[t] || (rec[t] = {
      actual: { W: 0, L: 0, T: 0 }, all: { W: 0, L: 0, T: 0 }, oppSum: 0, oppN: 0,
      actCat: { W: 0, L: 0, T: 0 }, allCat: { W: 0, L: 0, T: 0 }, oppCatSum: 0, oppCatN: 0,
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

      // goalie-minimum forfeits (finished weeks with goalie appearances recorded)
      const gp = (!wk.is_current && o.goalieMin && wk.goalie_gp) ? wk.goalie_gp : null;
      const short = t => !!gp && gp[t] != null && gp[t] < o.goalieMin;

      // all-play: every pair once
      const weekRec = {}, weekCat = {};
      teams.forEach(t => { weekRec[t] = { W: 0, L: 0, T: 0 }; weekCat[t] = { W: 0, L: 0, T: 0 }; get(t); });
      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const a = teams[i], b = teams[j];
          const k = catCounts(wk.stats[a], wk.stats[b], o.cats, short(a), short(b));
          const r = k.a > k.b ? "1" : k.b > k.a ? "2" : "T";
          if (r === "1") { weekRec[a].W++; weekRec[b].L++; }
          else if (r === "2") { weekRec[a].L++; weekRec[b].W++; }
          else { weekRec[a].T++; weekRec[b].T++; }
          weekCat[a].W += k.a; weekCat[a].L += k.b; weekCat[a].T += k.t;
          weekCat[b].W += k.b; weekCat[b].L += k.a; weekCat[b].T += k.t;
        }
      }
      const weekPct = {}, weekCatPct = {};
      for (const t of teams) {
        const r = weekRec[t], all = rec[t].all;
        all.W += r.W; all.L += r.L; all.T += r.T;
        weekPct[t] = pct(r);
        const c = weekCat[t], ac = rec[t].allCat;
        ac.W += c.W; ac.L += c.L; ac.T += c.T;
        weekCatPct[t] = pct(c);
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
        // category level: Yahoo's stored per-category results
        const c1 = rec[m.t1].actCat, c2 = rec[m.t2].actCat;
        for (const c of m.cats) {
          if (c === "1") { c1.W++; c2.L++; }
          else if (c === "2") { c1.L++; c2.W++; }
          else { c1.T++; c2.T++; }
        }
        if (weekCatPct[m.t2] != null) { rec[m.t1].oppCatSum += weekCatPct[m.t2]; rec[m.t1].oppCatN++; }
        if (weekCatPct[m.t1] != null) { rec[m.t2].oppCatSum += weekCatPct[m.t1]; rec[m.t2].oppCatN++; }
      }
    }

    const rows = Object.keys(rec).map(team => {
      const r = rec[team];
      const actPct = pct(r.actual), allPct = pct(r.all);
      const actCatPct = pct(r.actCat), allCatPct = pct(r.allCat);
      return {
        team,
        actual: r.actual, all: r.all,
        actPct, allPct,
        delta: (actPct != null && allPct != null) ? allPct - actPct : null,
        oppAll: r.oppN ? r.oppSum / r.oppN : null,
        actCat: r.actCat, allCat: r.allCat,
        actCatPct, allCatPct,
        deltaCat: (actCatPct != null && allCatPct != null) ? allCatPct - actCatPct : null,
        oppAllCat: r.oppCatN ? r.oppCatSum / r.oppCatN : null,
      };
    }).filter(r => r.allPct != null);

    rows.sort((a, b) => (b.allPct - a.allPct) || ((b.actPct ?? 0) - (a.actPct ?? 0)) || a.team.localeCompare(b.team));
    rows.forEach((r, i) => { r.rank = i + 1; });
    return { rows, weeks: used };
  }

  return { compute, pairing, catCounts, matchupResult, pct, CATS };
}));
