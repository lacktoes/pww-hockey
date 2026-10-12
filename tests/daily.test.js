// Run: node tests/daily.test.js
// One hand-made week, three teams, three days: who leads the weekly PWW score each day.
const assert = require("node:assert/strict");
const DR = require("../docs/daily.js");

const cols = ["G", "A", "PIM", "PPP", "SOG", "FW", "HIT", "BLK", "W", "SV", "SA", "SHO", "GP"];
const row = o => cols.map(c => o[c] || 0);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

// day 1: A scores 2, B scores 1, C nothing        -> G: A 100, B 50, C 0. A leads.
// day 2: C scores 4 and has 10 hits               -> G: C 100 (4), A 50 (2), B 0 (1)... HIT: C 100
// day 3: last day - the published weekly scores are used as they are.
const week = {
  is_current: false,
  stats: { A: {}, B: {}, C: {} },
  pww: { A: 300.5, B: 120.25, C: 410.75 },
  daily: { cols, days: {
    "2026-10-05": { A: row({ G: 2 }), B: row({ G: 1 }), C: row({}) },
    "2026-10-06": { A: row({}), B: row({}), C: row({ G: 4, HIT: 10 }) },
    "2026-10-07": { A: row({ A: 3 }), B: row({}), C: row({}) },
  } },
};

const res = DR.compute(week);
assert.deepEqual(res.teams, ["A", "B", "C"]);
assert.deepEqual(res.days.map(d => d.date), ["2026-10-05", "2026-10-06", "2026-10-07"]);
const [d1, d2, d3] = res.days;

// day 1: only goals separate the teams; each category is scaled lowest = 0, highest = full weight
close(d1.score.A, 100, "day 1 A");
close(d1.score.B, 50, "day 1 B");
close(d1.score.C, 0, "day 1 C");
assert.deepEqual([d1.rank.A, d1.rank.B, d1.rank.C], [1, 2, 3]);

// day 2: totals are cumulative - G is now A 2, B 1, C 4; HIT C 10, others 0
close(d2.score.C, 100 + 100, "day 2 C leads on G and HIT");
close(d2.score.A, (2 - 1) / (4 - 1) * 100, "day 2 A");
close(d2.score.B, 0, "day 2 B");
assert.deepEqual([d2.rank.C, d2.rank.A, d2.rank.B], [1, 2, 3]);

// day 3: the last day ends exactly on the published weekly scores
assert.deepEqual(d3.score, week.pww);
assert.equal(d3.final, true);
assert.deepEqual([d3.rank.C, d3.rank.A, d3.rank.B], [1, 2, 3]);

// a week in progress is not final, and still ends on the published (live) scores
const live = DR.compute(Object.assign({}, week, { is_current: true }));
assert.equal(live.days[2].final, false);
assert.deepEqual(live.days[2].score, week.pww);

// SV% comes from summed saves and shots: X 9/10 then 1/10 = .500 overall, Y 6/10 = .600,
// so Y takes SV% even though X's first day was .900.
const sv = { X: { SV: 10, SA: 20 }, Y: { SV: 6, SA: 10 } };
const s = DR.pww(sv, ["SV%"], [100]);
close(s.Y, 100, "Y leads SV% on totals");
close(s.X, 0, "X trails SV% on totals");
// SHO carries half weight
const sho = DR.pww({ X: { SHO: 1 }, Y: { SHO: 0 } }, DR.CATS, DR.WEIGHTS);
close(sho.X, 50, "a shutout is worth 50");

// level teams keep yesterday's order instead of swapping
const tie = DR.compute({ stats: { A: {}, B: {} }, daily: { cols, days: {
  "d1": { A: row({}), B: row({ G: 1 }) },          // B ahead
  "d2": { A: row({ G: 1 }), B: row({}) },          // level on everything now
} } });
assert.equal(tie.days[1].rank.B, 1, "level teams keep the previous day's order");

// no day-by-day totals (older seasons): nothing to draw
assert.equal(DR.compute({ stats: { A: {} } }), null);

console.log("daily tests passed");
