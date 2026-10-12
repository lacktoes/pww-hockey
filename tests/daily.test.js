// Run: node tests/daily.test.js
// Hand-made 4-team league. Week 1 is finished (3 days), week 2 is in progress (1 day).
const assert = require("node:assert/strict");
const DR = require("../docs/daily.js");

const cols = ["G", "A", "PIM", "PPP", "SOG", "FW", "HIT", "BLK", "W", "SV", "SA", "SHO", "GP"];
const row = o => cols.map(c => o[c] || 0);
const C = DR.CATS;
const T = C.map(() => "T");

// Week 1, A v B and C v D.
//  day 1: A scores a goal, nobody else does anything      -> A 13, B 11, C 12, D 12
//  day 2: B scores twice (G now 1-2) and wins a faceoff   -> A 11, B 13
//  day 3: final. Yahoo's official result has A winning 7-4-1 (say, a goalie forfeit the
//         totals can't show), so the last day must use it, not the running totals.
const officialAB = ["2", "T", "1", "1", "1", "1", "1", "1", "2", "2", "2", "1"];   // A 7, B 4, 1 tie
const week1 = {
  is_current: false, week_start: "2026-10-05", week_end: "2026-10-07",
  stats: { A: {}, B: {}, C: {}, D: {} },
  matchups: [{ t1: "A", t2: "B", cats: officialAB }, { t1: "C", t2: "D", cats: T }],
  daily: { cols, days: {
    "2026-10-05": { A: row({ G: 1 }), B: row({}), C: row({}), D: row({}) },
    "2026-10-06": { A: row({}), B: row({ G: 2, FW: 1 }), C: row({}), D: row({}) },
    "2026-10-07": { A: row({}), B: row({}), C: row({}), D: row({}) },
  } },
};
// Week 2 (live), A v C and B v D. SV% must come from summed SV / SA, not an average of rates:
//  C: 9/10 then 1/10 = .500 overall. D: 6/10 = .600. D leads SV% though C's first day was .900.
const week2 = {
  is_current: true, week_start: "2026-10-12", week_end: "2026-10-18",
  stats: { A: {}, B: {}, C: {}, D: {} },
  matchups: [{ t1: "A", t2: "C", cats: T }, { t1: "B", t2: "D", cats: T }],
  daily: { cols, days: { "2026-10-12": { A: row({ G: 3 }), B: row({}), C: row({}), D: row({}) } } },
};

const res = DR.compute({ "1": week1, "2": week2 });
const [d1, d2, d3, d4] = res.days;
assert.equal(res.days.length, 4);
assert.deepEqual(res.days.map(d => d.date), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-12"]);

// day 1: one category decided (G to A), 11 level
assert.deepEqual([d1.pts.A, d1.pts.B, d1.pts.C, d1.pts.D], [13, 11, 12, 12]);
assert.equal(d1.rank.A, 1);
assert.equal(d1.rank.B, 4);

// day 2: running totals flip it - B leads G (2-1) and FW (1-0)
assert.deepEqual([d2.pts.A, d2.pts.B], [10, 14]);
assert.equal(d2.rank.B, 1);
assert.equal(d2.rank.A, 4);

// day 3: the finished week's last day uses Yahoo's official categories (A 7-4-1)
assert.equal(d3.final, true);
assert.deepEqual([d3.pts.A, d3.pts.B], [15, 9]);
assert.equal(d3.rank.A, 1);
// every matchup hands out 24 points, so the league average is 12 a week
assert.equal(d3.pts.A + d3.pts.B + d3.pts.C + d3.pts.D, 48);
assert.ok(Math.abs(d3.rel.A - 3) < 1e-9);

// day 4 (live week): banked week-1 points + today's running score. A leads C on G only.
assert.equal(d4.live, true);
assert.equal(d4.final, false);
assert.deepEqual([d4.pts.A, d4.pts.C], [15 + 13, 12 + 11]);
// level teams keep yesterday's order: B (9+12) and D (12+12) are not level, D is ahead
assert.ok(d4.rank.D < d4.rank.B);

// SV% from summed saves and shots
const c = { SV: 10, SA: 20 }, d = { SV: 6, SA: 10 };
assert.equal(DR.catsOn(c, d)[C.indexOf("SV%")], "2", "SV% compares SV/SA totals (.500 v .600)");
assert.equal(DR.catsOn({ SV: 0, SA: 0 }, d)[C.indexOf("SV%")], "2", "no shots faced loses SV%");
assert.equal(DR.catsOn({}, {})[C.indexOf("SV%")], "T", "neither team has faced a shot: level");

// a week with no day-by-day totals still contributes one point at its end
const flat = DR.compute({ "1": Object.assign({}, week1, { daily: undefined }) });
assert.equal(flat.days.length, 1);
assert.equal(flat.days[0].date, "2026-10-07");
assert.deepEqual([flat.days[0].pts.A, flat.days[0].pts.B], [15, 9]);

console.log("daily tests passed");
