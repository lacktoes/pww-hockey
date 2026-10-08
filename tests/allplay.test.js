// Run: node tests/allplay.test.js
// Hand-made 4-team, 2-week league: A > B > C > D in every category. B draws A both weeks,
// so B's record is far worse than how B played. C and D are identical in week 1 (a tie).
const assert = require("node:assert/strict");
const AP = require("../docs/allplay.js");

const C = AP.CATS;
const line = v => Object.fromEntries(C.map(c => [c, c === "SV%" ? 0.880 + v / 1000 : v]));
const A = line(40), B = line(30), Cc = line(20), D = line(10);

// Stored per-category results, as fetch_data.py writes them ("1" = t1 wins the category).
const cats = (s1, s2) => C.map(c => (s1[c] > s2[c] ? "1" : s2[c] > s1[c] ? "2" : "T"));

const weeks = {
  "1": { is_current: false, stats: { A, B, C: Cc, D: Cc },          // C and D identical
         matchups: [{ t1: "A", t2: "B", cats: cats(A, B) }, { t1: "C", t2: "D", cats: cats(Cc, Cc) }] },
  "2": { is_current: false, stats: { A, B, C: Cc, D },
         matchups: [{ t1: "B", t2: "A", cats: cats(B, A) }, { t1: "C", t2: "D", cats: cats(Cc, D) }] },
  "3": { is_current: true, stats: { A: D, B: A, C: Cc, D: B },    // live week: B finally wins
         matchups: [{ t1: "A", t2: "B", cats: cats(D, A) }, { t1: "C", t2: "D", cats: cats(Cc, B) }] },
};

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const byTeam = res => Object.fromEntries(res.rows.map(r => [r.team, r]));

// --- finished weeks only (default)
const res = AP.compute(weeks);
const t = byTeam(res);
assert.deepEqual(res.weeks, [1, 2], "the live week is excluded by default");

// B: 2nd-best team, drew the best team both weeks.
assert.deepEqual(t.B.actual, { W: 0, L: 2, T: 0 });
assert.deepEqual(t.B.all, { W: 4, L: 2, T: 0 });                  // beats C and D each week
close(t.B.actPct, 0, "B actual %");
close(t.B.allPct, 4 / 6, "B all-play %");
assert.ok(t.B.delta > 0, "B is unlucky: positive delta");
close(t.B.delta, 4 / 6, "B delta");
close(t.B.oppAll, 1, "B's opponent (A) went 3-0 all-play both weeks: opp all-play 100%");

// A: mirror image - lucky only in the sense of 0 delta (won everything both ways).
close(t.A.allPct, 1, "A all-play %");
close(t.A.delta, 0, "A delta");

// Ties count as half. Week 1 C v D level on every category -> tied pairing.
assert.deepEqual(t.C.actual, { W: 1, L: 0, T: 1 });
close(t.C.actPct, 0.75, "C actual % with a tie as half");
assert.deepEqual(t.C.all, { W: 1, L: 4, T: 1 });                  // wk1: L A, L B, T D; wk2: L A, L B, W D
close(t.C.allPct, 1.5 / 6, "C all-play % with a tie as half");
close(t.C.delta, 0.25 - 0.75, "C delta (lucky: negative)");

// Ranking by all-play %.
assert.deepEqual(res.rows.map(r => r.team), ["A", "B", "C", "D"]);
assert.deepEqual(res.rows.map(r => r.rank), [1, 2, 3, 4]);

// --- include this week so far
const live = byTeam(AP.compute(weeks, { includeCurrent: true }));
assert.deepEqual(live.B.actual, { W: 1, L: 2, T: 0 }, "live week counted when asked");

// SV% is compared as the rate it is stored as (a higher rate wins the category).
assert.equal(AP.pairing({ "SV%": 0.912 }, { "SV%": 0.905 }, ["SV%"]), "1");

console.log("allplay tests passed");
