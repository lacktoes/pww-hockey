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

// Goalie minimum: a team short of the minimum forfeits W/SV/SV%/SHO to anyone who met it.
// Two identical teams, X short (2 GP) and Y fine (3 GP): Y takes all 4 goalie categories
// and the pairing (4-0 with 8 tied); without the rule they would tie 0-0-12.
const same = line(25);
const gw = { "1": { is_current: false, stats: { X: same, Y: same }, goalie_gp: { X: 2, Y: 3 },
                    matchups: [{ t1: "X", t2: "Y", cats: C.map(c => (["W", "SV", "SV%", "SHO"].includes(c) ? "2" : "T")) }] } };
const g = byTeam(AP.compute(gw, { goalieMin: 3 }));
assert.deepEqual(g.Y.all, { W: 1, L: 0, T: 0 }, "Y wins the all-play pairing on goalie forfeits");
assert.deepEqual(g.X.all, { W: 0, L: 1, T: 0 });
assert.deepEqual(g.X.actual, { W: 0, L: 1, T: 0 }, "actual record follows Yahoo's stored result");
const noRule = byTeam(AP.compute(gw));
assert.deepEqual(noRule.Y.all, { W: 0, L: 0, T: 1 }, "without a minimum the identical teams tie");
const gwLive = JSON.parse(JSON.stringify(gw)); gwLive["1"].is_current = true;
assert.deepEqual(byTeam(AP.compute(gwLive, { goalieMin: 3, includeCurrent: true })).Y.all,
                 { W: 0, L: 0, T: 1 }, "the minimum is not applied to a week in progress");

// --- category level: share of the 24 points per matchup (2 per category won, 1 per tie)
// P wins the first 7 categories against both Q and R and loses the other 5: P wins every
// matchup 7-5, so 100% at matchup level but only 14 of 24 categories = 58.3%.
// Q beats R in all 12. R ties Q on SHO in week 2 to check that a tie counts as half.
const hiLo = (hi, lo, split) => Object.fromEntries(C.map((c, i) => [c, i < split ? hi : lo]));
const P = hiLo(50, 1, 7), Q = hiLo(20, 40, 7), R = hiLo(10, 30, 7);
const cw = {
  "1": { is_current: false, stats: { P, Q, R },
         matchups: [{ t1: "P", t2: "Q", cats: cats(P, Q) }] },
};
const cres = byTeam(AP.compute(cw));
assert.deepEqual(cres.P.all, { W: 2, L: 0, T: 0 });
close(cres.P.allPct, 1, "P wins every matchup");
assert.deepEqual(cres.P.allCat, { W: 14, L: 10, T: 0 });
close(cres.P.allCatPct, 14 / 24, "P takes 58.3% of the categories");
assert.deepEqual(cres.P.actCat, { W: 7, L: 5, T: 0 }, "actual categories from the stored result");
close(cres.P.actCatPct, 7 / 12, "P's actual category share");
close(cres.Q.allCatPct, (5 + 12) / 24, "Q: 5 of 12 v P, 12 of 12 v R");
close(cres.Q.deltaCat, 17 / 24 - 5 / 12, "Q's category delta");
// opponent strength at category level: Q's opponent P took 14/24 that week
close(cres.Q.oppAllCat, 14 / 24, "Q's opponent's all-play category share");
// every category handed out is someone's win, loss or tie: the league averages exactly 50%
const avg = Object.values(cres).reduce((s, r) => s + r.allCatPct, 0) / 3;
close(avg, 0.5, "all-play category shares average 50%");

// a tied category counts as half: S and U level on SHO only, S wins the other 11
const S = hiLo(5, 0, 11), U = hiLo(1, 0, 11);
const tie = byTeam(AP.compute({ "1": { is_current: false, stats: { S, U }, matchups: [] } }));
assert.deepEqual(tie.S.allCat, { W: 11, L: 0, T: 1 });
close(tie.S.allCatPct, 11.5 / 12, "a tied category is half");

// goalie minimum at category level: identical teams, X short -> Y takes the 4 goalie
// categories and the other 8 are tied: Y (4 + 8 * 0.5) / 12 = 66.7%, X 33.3%
close(g.Y.allCatPct, 8 / 12, "goalie forfeit: Y 66.7% of categories");
close(g.X.allCatPct, 4 / 12, "goalie forfeit: X 33.3% of categories");
assert.deepEqual(AP.catCounts(same, same, C, true, true), { a: 0, b: 0, t: 12 }, "both short: tied");

console.log("allplay tests passed");
