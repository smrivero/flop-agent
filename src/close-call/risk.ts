/**
 * Risk engine: prices, sizes and validates a pair trade BEFORE it could ever be sent.
 *
 * Every check the fold performs is reproduced (same order, via ledger.ts) and a few
 * stricter ones are added (taker must be named, 128-bit id, no flips, reserve).
 * Funds are checked not only at the estimated close but at the edges of the margin
 * band, because the real close is unknown when we sign. The paper trader then runs
 * the same trades through the OFFICIAL fold (fold.check) and blocks on any
 * disagreement: an intent goes out only if both say "settled".
 */

import { ceilTo, CENT, floorTo, fmt2, fmtShort, max, min, mul, parseAmount, SCALE, TWO_PLACES, type Micro } from "./decimal.js";
import { sideFees, type Ledger, type LedgerAccount, type Side, type WireTrade } from "./ledger.js";
import { limitsFor, TRADE_ID_RE } from "./protocol.js";
import type { Favored } from "./strategy/k-ladder.js";

export const FEE_DEN_LONG = 1_010_000n;   // 1.01
export const FEE_DEN_SHORT = 990_000n;    // 0.99

const frac = (x: number): Micro => BigInt(Math.round(x * 1e6));

function divFloor(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}
function divCeil(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && (a < 0n) === (b < 0n) ? q + 1n : q;
}

/**
 * Fee-optimal price for the favoured side, from the ESTIMATED close:
 *   long : floor_cent(est / 1.01 / (1 + margin))   buyer pays exactly the close if close >= 1.01*px
 *   short: ceil_cent (est / 0.99 * (1 + margin))   seller receives exactly the close if close <= 0.99*px
 * clamped into the limits posted for this sweep.
 */
export function favoredPrice(favored: Favored, est: Micro, margin: number, limits: [Micro, Micro]): Micro {
  const m = frac(margin);
  let p: Micro;
  if (favored === "long") {
    p = floorTo(divFloor(est * SCALE * SCALE, FEE_DEN_LONG * (SCALE + m)), CENT);
  } else {
    p = ceilTo(divCeil(est * (SCALE + m), FEE_DEN_SHORT), CENT);
  }
  return min(max(p, limits[0]), limits[1]);
}

/** Closes to test the funds check against: the estimate and both edges of the margin band, in cents. */
export function closeBand(est: Micro, qtyMargin: number): Micro[] {
  const m = frac(qtyMargin);
  const lo = floorTo(divFloor(est * (SCALE - m), SCALE), CENT);
  const hi = ceilTo(divCeil(est * (SCALE + m), SCALE), CENT);
  return [...new Set([lo, floorTo(est, CENT), ceilTo(est, CENT), hi])];
}

function sideNeed(p: Ledger["p"], acct: LedgerAccount, side: Side, qty: Micro, px: Micro, close: Micro): { need: Micro; fee: Micro; opening: Micro } {
  const [buyerFee, sellerFee] = sideFees(p, 1, qty, px, close);
  const fee = side > 0 ? buyerFee : sellerFee;
  const opening = acct.opening(side, qty);
  return { need: mul(opening, px) + fee, fee, opening };
}

const usable = (cash: Micro, reserve: number): Micro => cash - divCeil(cash * frac(reserve), SCALE);

/** Largest 0.01-step quantity both sides can fund at every close in the band, keeping `reserve` of cash. */
export function maxPairQty(ledger: Ledger, buyer: LedgerAccount, seller: LedgerAccount, px: Micro, band: Micro[], reserve: number): Micro {
  const ok = (q: Micro) => band.every((c) =>
    usable(buyer.cash, reserve) >= sideNeed(ledger.p, buyer, 1, q, px, c).need &&
    usable(seller.cash, reserve) >= sideNeed(ledger.p, seller, -1, q, px, c).need);
  let lo = 0n;
  let hi = (max(buyer.cash, seller.cash) * 2n * SCALE) / px + CENT;
  hi = floorTo(hi, CENT);
  while (hi - lo > CENT) {
    const mid = floorTo((lo + hi) / 2n, CENT);
    if (mid <= lo) break;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return ok(hi) ? hi : lo;
}

export interface RiskCheck { name: string; ok: boolean; detail?: string }

export interface RiskContext {
  ledger: Ledger;               // paper ledger, with our keys minted (or a clone with them minted)
  sweep: number;
  lockSweep: number;
  ref: Micro;                   // the referee reference this sweep's limits come from
  postedLimits: [Micro, Micro] | null;
  estimate: Micro;
  qtyMargin: number;
  reserve: number;
  knownSettledIds: (id: string) => boolean;
  ourIds: Set<string>;
  earlierTrades: WireTrade[];   // our other trades in the same sweep, applied first
  keyStatus?: (did: string) => string | undefined;   // lifecycle state (keys.ts); must be READY or ACTIVE
}

export interface RiskResult {
  ok: boolean;
  checks: RiskCheck[];
  expected: { makerFee: string; takerFee: string; makerCollateral: string; takerCollateral: string; makerOpening: string; takerOpening: string };
}

/** Validate one wire trade (maker buys, countersigner sells, taker named) against every rule we know. */
export function validateTrade(t: WireTrade, ctx: RiskContext): RiskResult {
  const checks: RiskCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  const qty = parseAmount(t.qty);
  const px = parseAmount(t.px);
  add("shape", qty !== null && px !== null && TWO_PLACES.test(t.qty) && TWO_PLACES.test(t.px) && (t.side === "buy" || t.side === "sell") &&
    Number.isInteger(t.until), `qty=${t.qty} px=${t.px}`);
  add("min_qty", qty !== null && qty >= ctx.ledger.p.minQty, `min ${fmtShort(ctx.ledger.p.minQty)}`);
  add("qty_step", qty !== null && qty % CENT === 0n);
  add("price_step", px !== null && px % CENT === 0n);
  add("id_format", TRADE_ID_RE.test(t.id) && /^[0-9a-f]{32}$/.test(t.id), "128-bit hex");
  add("id_unique", !ctx.knownSettledIds(t.id) && !ctx.ourIds.has(t.id), "never settled by anyone, never used by us");
  add("taker_named", t.taker !== "any" && t.taker === t.countersigner, "never an open offer");
  add("until", Number.isInteger(t.until) && t.until >= ctx.sweep && t.until <= ctx.lockSweep, `until=${t.until} sweep=${ctx.sweep}`);
  add("not_locked", ctx.sweep <= ctx.lockSweep);
  if (ctx.keyStatus) {
    const ms = ctx.keyStatus(t.maker);
    const ts = ctx.keyStatus(t.countersigner);
    add("keys_mint_confirmed", ["READY", "ACTIVE"].includes(ms ?? "") && ["READY", "ACTIVE"].includes(ts ?? ""), `maker ${ms}, taker ${ts}`);
  }
  const [flo, fhi] = limitsFor(ctx.ref, ctx.ledger.p.window);
  const posted = ctx.postedLimits ?? [flo, fhi];
  add("limits_formula_matches_posted", posted[0] === flo && posted[1] === fhi, `posted ${fmt2(posted[0])}-${fmt2(posted[1])} formula ${fmt2(flo)}-${fmt2(fhi)}`);
  add("limits", px !== null && px >= posted[0] && px <= posted[1], `px ${t.px} in [${fmt2(posted[0])}, ${fmt2(posted[1])}]`);

  // Apply our earlier trades of the same sweep on a clone, as the fold would (sequential funds).
  const l = ctx.ledger.clone();
  if (ctx.earlierTrades.length) {
    l.sweepN = Math.min(l.sweepN, ctx.sweep - 1);
    l.sweep(ctx.sweep, ctx.ref, ctx.estimate, [], ctx.earlierTrades);
  }
  const maker = l.accounts.get(t.maker);
  const taker = l.accounts.get(t.countersigner);
  add("owners", !!maker && !!taker, "both keys minted");
  let expected = { makerFee: "-", takerFee: "-", makerCollateral: "-", takerCollateral: "-", makerOpening: "-", takerOpening: "-" };
  if (maker && taker && qty !== null && px !== null) {
    const side: Side = t.side === "buy" ? 1 : -1;
    const mAt = sideNeed(l.p, maker, side, qty, px, ctx.estimate);
    const tAt = sideNeed(l.p, taker, -side as Side, qty, px, ctx.estimate);
    expected = {
      makerFee: fmtShort(mAt.fee), takerFee: fmtShort(tAt.fee),
      makerCollateral: fmtShort(mul(mAt.opening, px)), takerCollateral: fmtShort(mul(tAt.opening, px)),
      makerOpening: fmtShort(mAt.opening), takerOpening: fmtShort(tAt.opening),
    };
    add("no_flip", (mAt.opening === qty || mAt.opening === 0n) && (tAt.opening === qty || tAt.opening === 0n),
      "a trade must either only open or only close for each side");
    for (const c of closeBand(ctx.estimate, ctx.qtyMargin)) {
      const mk = sideNeed(l.p, maker, side, qty, px, c);
      const tk = sideNeed(l.p, taker, -side as Side, qty, px, c);
      add(`funds@${fmt2(c)}`, usable(maker.cash, ctx.reserve) >= mk.need && usable(taker.cash, ctx.reserve) >= tk.need,
        `maker needs ${fmtShort(mk.need)} of ${fmtShort(maker.cash)}, taker needs ${fmtShort(tk.need)} of ${fmtShort(taker.cash)}`);
    }
    const mirror = l.check(t, ctx.sweep, ctx.ref, ctx.estimate);
    add("fold_mirror_check", mirror === null, mirror ?? "settles at the estimated close");
  }
  return { ok: checks.every((c) => c.ok), checks, expected };
}
