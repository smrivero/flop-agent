import assert from "node:assert/strict";
import { test } from "node:test";
import { fmt2, toMicro, type Micro } from "./decimal.js";
import { paperDid } from "./keys.js";
import { Ledger, type WireTrade } from "./ledger.js";
import { foldParams } from "./paper.js";
import { limitsFor } from "./protocol.js";
import { closeBand, favoredPrice, maxPairQty, validateTrade, type RiskContext } from "./risk.js";
import { contest } from "./test-helpers.js";

const C = toMicro("226.14");
const LIM = limitsFor(C, 50_000n);
const [A, B, X, Y] = ["RA", "RB", "RX", "RY"].map(paperDid);

function ledger(): Ledger {
  const l = new Ledger(foldParams(contest()));
  l.mintAll([A, B, X, Y], 1);
  l.sweepN = 1;
  return l;
}

const trade = (o: Partial<WireTrade> = {}): WireTrade => ({ id: "0123456789abcdef0123456789abcdef", maker: A, side: "buy", qty: "10.00", px: "223.90",
  taker: B, until: 5, countersigner: B, ...o });

function ctx(l: Ledger, o: Partial<RiskContext> = {}): RiskContext {
  return { ledger: l, sweep: 5, lockSweep: 2556, ref: C, postedLimits: LIM, estimate: C, qtyMargin: 0.003, reserve: 0,
    knownSettledIds: () => false, ourIds: new Set(), earlierTrades: [], ...o };
}

const failed = (r: ReturnType<typeof validateTrade>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

test("fee-optimal prices match the research proof (margin 0): floor(c/1.01) and ceil(c/0.99)", () => {
  assert.equal(fmt2(favoredPrice("long", C, 0, LIM)), "223.90");
  assert.equal(fmt2(favoredPrice("short", C, 0, LIM)), "228.43");
  assert.ok(favoredPrice("long", C, 0.001, LIM) < toMicro("223.90"));
  assert.ok(favoredPrice("short", C, 0.001, LIM) > toMicro("228.43"));
  assert.equal(fmt2(favoredPrice("long", C, 0.2, LIM)), fmt2(LIM[0]), "clamped into the posted limits");
});

test("max qty: favoured long all-in is floor(10000/c) at margin 0, smaller with a margin or a reserve", () => {
  const l = ledger();
  const px = favoredPrice("long", C, 0, LIM);
  assert.equal(fmt2(maxPairQty(l, l.accounts.get(A)!, l.accounts.get(B)!, px, [C], 0)), "44.22");
  const withMargin = maxPairQty(l, l.accounts.get(A)!, l.accounts.get(B)!, px, closeBand(C, 0.003), 0);
  assert.ok(withMargin < toMicro("44.22"));
  const withReserve = maxPairQty(l, l.accounts.get(A)!, l.accounts.get(B)!, px, [C], 0.02);
  assert.ok(withReserve < withMargin);
});

test("a correct favoured pair passes every check and reports fee, collateral and opening", () => {
  const r = validateTrade(trade({ qty: "44.00" }), ctx(ledger()));
  assert.deepEqual(failed(r), []);
  assert.equal(r.expected.makerFee, "98.56");            // (226.14 - 223.90) * 44 = 98.56 > 1% of 9851.60: the clawback, buyer pays exactly c
  assert.equal(r.expected.makerCollateral, "9851.6");
  assert.equal(r.expected.makerOpening, "44");
});

test("shape, min qty, qty step and price step", () => {
  assert.ok(failed(validateTrade(trade({ qty: "0.09" }), ctx(ledger()))).includes("min_qty"));
  assert.ok(failed(validateTrade(trade({ qty: "1.234" }), ctx(ledger()))).includes("shape"));
  assert.ok(failed(validateTrade(trade({ px: "223.9" }), ctx(ledger()))).length === 0, "one decimal is a valid 0.01 step");
  assert.ok(failed(validateTrade(trade({ px: "223.905" }), ctx(ledger()))).includes("shape"));
});

test("limits: inclusive edge, one cent outside fails, and posted limits must match the formula", () => {
  assert.deepEqual(failed(validateTrade(trade({ px: fmt2(LIM[1]), qty: "1.00" }), ctx(ledger()))), []);
  assert.ok(failed(validateTrade(trade({ px: fmt2(LIM[1] + 10_000n), qty: "1.00" }), ctx(ledger()))).includes("limits"));
  const bad: [Micro, Micro] = [LIM[0], LIM[1] + 10_000n];
  assert.ok(failed(validateTrade(trade(), ctx(ledger(), { postedLimits: bad }))).includes("limits_formula_matches_posted"));
});

test("until and lock", () => {
  assert.ok(failed(validateTrade(trade({ until: 4 }), ctx(ledger()))).includes("until"));
  assert.ok(failed(validateTrade(trade({ until: 2600 }), ctx(ledger(), { sweep: 2557 }))).includes("not_locked"));
});

test("duplicate ids: settled by anyone before, or already used by us, or not 128-bit", () => {
  const t = trade();
  assert.ok(failed(validateTrade(t, ctx(ledger(), { knownSettledIds: (id) => id === t.id }))).includes("id_unique"));
  assert.ok(failed(validateTrade(t, ctx(ledger(), { ourIds: new Set([t.id]) }))).includes("id_unique"));
  assert.ok(failed(validateTrade(trade({ id: "a7f3" }), ctx(ledger()))).includes("id_format"));
});

test("open offers are refused: the taker must be named", () => {
  assert.ok(failed(validateTrade(trade({ taker: "any" }), ctx(ledger()))).includes("taker_named"));
});

test("funds across the close band: an all-in size at the estimate fails when the close can tick up", () => {
  const l = ledger();
  const r = validateTrade(trade({ qty: "44.22" }), ctx(l, { qtyMargin: 0.003 }));
  assert.ok(failed(r).some((n) => n.startsWith("funds@")), "44.22 is only fundable if the close is exactly 226.14");
  assert.deepEqual(failed(validateTrade(trade({ qty: "44.22" }), ctx(l, { qtyMargin: 0 }))), []);
});

test("cash reserve is enforced on top of the fold's own funds rule", () => {
  assert.ok(failed(validateTrade(trade({ qty: "44.00" }), ctx(ledger(), { reserve: 0.05 }))).some((n) => n.startsWith("funds@")));
});

test("opening vs closing, FIFO and flips", () => {
  const l = ledger();
  l.sweep(2, C, C, [], [trade({ id: "f1".padEnd(32, "0"), qty: "10.00", px: "226.14" }), trade({ id: "f2".padEnd(32, "0"), qty: "5.00", px: "220.00", until: 9 })]);
  const a = l.accounts.get(A)!;
  assert.deepEqual(a.lots.map((x) => [fmt2(x.qty), fmt2(x.px)]), [["10.00", "226.14"], ["5.00", "220.00"]]);
  // A sells 12 to X: closes the first lot fully (FIFO) and 2 of the second, opens nothing
  const closeOnly = trade({ id: "c1".padEnd(32, "0"), maker: A, side: "sell", qty: "12.00", px: "226.14", taker: X, countersigner: X });
  const r = validateTrade(closeOnly, ctx(l));
  assert.equal(r.expected.makerOpening, "0");
  assert.ok(!failed(r).includes("no_flip"));
  l.sweep(3, C, C, [], [closeOnly]);
  assert.deepEqual(a.lots.map((x) => [fmt2(x.qty), fmt2(x.px)]), [["3.00", "220.00"]]);
  // selling 10 now would close 3 and open 7 short: a flip, refused by policy
  const flip = trade({ id: "c2".padEnd(32, "0"), maker: A, side: "sell", qty: "10.00", px: "226.14", taker: X, countersigner: X });
  assert.ok(failed(validateTrade(flip, ctx(l))).includes("no_flip"));
});

test("our earlier trades in the same sweep are applied first (sequential funds, like the fold)", () => {
  const l = ledger();
  const first = trade({ id: "e1".padEnd(32, "0"), qty: "44.00" });
  const second = trade({ id: "e2".padEnd(32, "0"), qty: "1.00", maker: A, taker: X, countersigner: X });
  assert.deepEqual(failed(validateTrade(second, ctx(l))), []);
  assert.ok(failed(validateTrade(second, ctx(l, { earlierTrades: [first] }))).some((n) => n.startsWith("funds@")));
});
