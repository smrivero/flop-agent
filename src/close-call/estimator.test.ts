import assert from "node:assert/strict";
import { test } from "node:test";
import { fmt2, toMicro, type Micro } from "./decimal.js";
import { errorBps, estimateClose } from "./estimator.js";
import { paperDid } from "./keys.js";
import { Ledger, type WireTrade } from "./ledger.js";
import { foldParams } from "./paper.js";
import { limitsFor } from "./protocol.js";
import { favoredPrice, maxPairQty } from "./risk.js";
import { contest } from "./test-helpers.js";

const HL = (px: string, ageMs: number) => ({ hl: { px, tid: "1", timeMs: 0 }, hlAgeMs: ageMs });

test("estimator sources: ref (A), hl (B), combined (C)", () => {
  const base = { lastRefPx: "225.03", lastRefAgeS: 3, ...HL("226.50", 2_000) };
  assert.equal(fmt2(estimateClose("ref", base, 60_000, 300)!.value), "225.03");
  assert.equal(fmt2(estimateClose("hl", base, 60_000, 300)!.value), "226.50");
  const c = estimateClose("combined", base, 60_000, 300)!;
  assert.equal(c.used, "hl");
  assert.equal(c.stale, false);
  // referee stale: it keeps reusing its old trade, so combined expects the old close and flags stale
  const s = estimateClose("combined", { ...base, lastRefAgeS: 5102 }, 60_000, 300)!;
  assert.equal(fmt2(s.value), "225.03");
  assert.equal(s.stale, true);
  // Hyperliquid stale or missing: fall back to the referee
  assert.equal(estimateClose("combined", { ...base, ...HL("226.50", 600_000) }, 60_000, 300)!.used, "ref");
  assert.equal(estimateClose("combined", { lastRefPx: "225.03", lastRefAgeS: 3, hl: null, hlAgeMs: null }, 60_000, 300)!.used, "ref");
  assert.equal(estimateClose("combined", { lastRefPx: null, lastRefAgeS: null, hl: null, hlAgeMs: null }, 60_000, 300), null);
});

test("estimated_close vs actual_close: error in basis points", () => {
  assert.equal(errorBps(toMicro("226.50"), toMicro("226.50")), 0);
  assert.equal(errorBps(toMicro("226.73"), toMicro("226.50")).toFixed(2), "10.15");
  assert.equal(errorBps(toMicro("225.03"), toMicro("230.00")).toFixed(1), "-216.1");
});

/**
 * Look-ahead bias. Choosing px (and size) from the sweep's REAL close makes the favoured side pay
 * exactly the close, all-in, with no margin, on every path -- a result no live agent can reach,
 * because the close is fixed at the boundary, after the trade must already be signed and posted.
 * The same rule fed with an honest estimate (the price 20 s earlier) is voided or overpays.
 */
test("pricing with the real sweep close is look-ahead bias: it beats every honest estimate", () => {
  const p = foldParams(contest());
  const [A, B] = ["LA", "LB"].map(paperDid);
  const closes = ["226.14", "226.70", "225.60", "227.90", "224.10"].map(toMicro);
  const estimates = ["226.14", "226.40", "225.90", "227.40", "224.60"].map(toMicro);   // live price 20 s before
  let lookScore = 0n, honestScore = 0n, honestVoids = 0;
  const S = toMicro("235.00");
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    const lim = limitsFor(toMicro("226.14"), p.window);
    const run = (priceFrom: Micro) => {
      const l = new Ledger(p);
      l.mintAll([A, B], 1);
      l.sweepN = 1;
      const px = favoredPrice("long", priceFrom, 0, lim);
      const qty = maxPairQty(l, l.accounts.get(A)!, l.accounts.get(B)!, px, [priceFrom], 0);
      const t: WireTrade = { id: "a".repeat(32), maker: A, side: "buy", qty: fmt2(qty), px: fmt2(px), taker: B, until: 2, countersigner: B };
      const out = l.sweep(2, toMicro("226.14"), c, [], [t]).outcomes[0];
      return { out, score: l.accounts.get(A)!.valueAt(S) - p.mint, px, qty };
    };
    const look = run(c);
    const honest = run(estimates[i]);
    assert.equal(look.out.outcome, "settled", "look-ahead always settles");
    assert.equal(look.out.makerFee, (c - look.px) * look.qty / 1_000_000n, "look-ahead: fee is exactly the gap, buyer pays exactly c");
    lookScore += look.score;
    if (honest.out.outcome === "void") honestVoids++;
    else honestScore += honest.score;
    assert.ok(look.score >= honest.score, `path ${i}: look-ahead ${look.score} >= honest ${honest.score}`);
  }
  assert.ok(honestVoids > 0, "an all-in honest estimate gets voided when the close ticks up");
  assert.ok(lookScore > honestScore, "the look-ahead book scores strictly more: it uses information we cannot have");
});
