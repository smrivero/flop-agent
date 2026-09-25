/**
 * A line-by-line TypeScript mirror of the vendored close_call_fold.py (Account,
 * side_fees, check, sweep application), in exact micro-units.
 *
 * It exists so the risk engine can run the fold's checks synchronously on
 * hypothetical closes. It is NOT the authority: the vendored Python fold is (see
 * fold.ts). ledger.test.ts runs both on the same random trades and requires
 * identical outcomes, fees, cash and lots, and the risk engine refuses an intent
 * if the two ever disagree.
 */

import { abs, max, min, mul, parseAmount, SCALE, type Micro } from "./decimal.js";
import { DID_RE, TRADE_ID_RE } from "./protocol.js";

export type Side = 1 | -1;
export type VoidReason = "shape" | "not_owner" | "taker" | "settled" | "expired" | "locked" | "limits" | "funds";

export interface Lot { qty: Micro; px: Micro } // qty > 0 long, < 0 short

export interface FoldParams { mint: Micro; minQty: Micro; window: Micro; feeRate: Micro; lock: number }

export class LedgerAccount {
  lots: Lot[] = [];
  fees: Micro = 0n;
  constructor(public key: string, public cash: Micro) {}

  get position(): Micro {
    return this.lots.reduce((s, l) => s + l.qty, 0n);
  }

  /** Contracts this trade opens rather than closes; side +1 buys, -1 sells. */
  opening(side: Side, qty: Micro): Micro {
    const held = this.position;
    const sideB = BigInt(side);
    const closing = min(qty, max(-sideB * held, 0n));
    return qty - closing;
  }

  /** Returns the closed part (for reporting). */
  apply(side: Side, qty: Micro, px: Micro, fee: Micro): { closed: Micro; realized: Micro } {
    this.cash -= fee;
    this.fees += fee;
    let left = qty;
    let closed = 0n;
    let realized = 0n;
    const sideB = BigInt(side);
    while (left > 0n && this.lots.length && this.lots[0].qty * sideB < 0n) {
      const lot = this.lots[0];
      const size = min(left, abs(lot.qty));
      if (side < 0) {
        this.cash += mul(size, px);                       // a long lot sold returns the sale price
        realized += mul(size, px - lot.px);
      } else {
        this.cash += mul(size, 2n * lot.px - px);         // a short lot bought back: collateral + gain
        realized += mul(size, lot.px - px);
      }
      left -= size;
      closed += size;
      if (size === abs(lot.qty)) this.lots.shift();
      else lot.qty = lot.qty + sideB * size;
    }
    if (left > 0n) {
      this.cash -= mul(left, px);                          // every contract opened ties up its price
      this.lots.push({ qty: sideB * left, px });
    }
    return { closed, realized };
  }

  valueAt(s: Micro): Micro {
    return this.cash + this.lots.reduce((acc, l) => acc + (l.qty > 0n ? mul(l.qty, s) : mul(-l.qty, 2n * l.px - s)), 0n);
  }

  clone(): LedgerAccount {
    const a = new LedgerAccount(this.key, this.cash);
    a.lots = this.lots.map((l) => ({ ...l }));
    a.fees = this.fees;
    return a;
  }
}

/** (maker fee, taker fee) for a maker on `side`: fee rate on value, or the gap vs the sweep close if larger. */
export function sideFees(p: FoldParams, side: Side, qty: Micro, px: Micro, close: Micro): [Micro, Micro] {
  const base = mul(p.feeRate, mul(qty, px));
  const gap = mul(close - px, qty);            // > 0: the buyer paid less than the close
  const buyer = max(base, gap);
  const seller = max(base, -gap);
  return side > 0 ? [buyer, seller] : [seller, buyer];
}

export interface WireTrade {
  id: string;
  maker: string;
  side: "buy" | "sell";
  qty: string;
  px: string;
  taker: string;
  until: number;
  countersigner: string;
}

export class Ledger {
  accounts = new Map<string, LedgerAccount>();
  settled = new Set<string>();
  sweepN = 0;
  fees: Micro = 0n;
  constructor(public p: FoldParams) {}

  mintAll(keys: string[], n: number): string[] {
    const out: string[] = [];
    for (const k of keys) {
      if (DID_RE.test(k) && !this.accounts.has(k) && n <= this.p.lock) {
        this.accounts.set(k, new LedgerAccount(k, this.p.mint));
        out.push(k);
      }
    }
    return out;
  }

  /** The fold's check(): the void reason, or null if it settles. Same order as the fold. */
  check(t: WireTrade, n: number, ref: Micro, close: Micro): VoidReason | null {
    if (!t || typeof t !== "object") return "shape";
    const qty = parseAmount(t.qty);
    const px = parseAmount(t.px);
    if (typeof t.id !== "string" || !TRADE_ID_RE.test(t.id) || (t.side !== "buy" && t.side !== "sell") || qty === null ||
      px === null || !Number.isInteger(t.until) || typeof t.maker !== "string" || typeof t.countersigner !== "string" ||
      !(t.taker === "any" || typeof t.taker === "string")) return "shape";
    if (qty < this.p.minQty) return "shape";
    const mk = this.accounts.get(t.maker);
    const tk = this.accounts.get(t.countersigner);
    if (!mk || !tk) return "not_owner";
    if (t.taker !== "any" && t.taker !== t.countersigner) return "taker";
    if (this.settled.has(t.id)) return "settled";
    if (n > t.until) return "expired";
    if (n > this.p.lock) return "locked";
    if (abs(px - ref) > mul(this.p.window, ref)) return "limits";
    const side: Side = t.side === "buy" ? 1 : -1;
    const [mkFee, tkFee] = sideFees(this.p, side, qty, px, close);
    if (mk === tk) {
      if (mk.cash < mkFee + tkFee) return "funds";
    } else if (mk.cash < mul(mk.opening(side, qty), px) + mkFee || tk.cash < mul(tk.opening(-side as Side, qty), px) + tkFee) {
      return "funds";
    }
    return null;
  }

  sweep(n: number, ref: Micro, close: Micro, owners: string[], trades: WireTrade[]) {
    if (n <= this.sweepN) throw new Error(`sweep ${n}: sweep numbers must increase`);
    this.sweepN = n;
    const minted = this.mintAll(owners, n);
    const outcomes: { id: string; outcome: "settled" | "void"; reason?: VoidReason; makerFee?: Micro; takerFee?: Micro }[] = [];
    for (const t of trades) {
      const reason = this.check(t, n, ref, close);
      if (reason) {
        outcomes.push({ id: t.id, outcome: "void", reason });
        continue;
      }
      const qty = parseAmount(t.qty)!;
      const px = parseAmount(t.px)!;
      const side: Side = t.side === "buy" ? 1 : -1;
      const [mkFee, tkFee] = sideFees(this.p, side, qty, px, close);
      const mk = this.accounts.get(t.maker)!;
      const tk = this.accounts.get(t.countersigner)!;
      if (mk === tk) {
        mk.cash -= mkFee + tkFee;
        mk.fees += mkFee + tkFee;
      } else {
        mk.apply(side, qty, px, mkFee);
        tk.apply(-side as Side, qty, px, tkFee);
      }
      this.fees += mkFee + tkFee;
      this.settled.add(t.id);
      outcomes.push({ id: t.id, outcome: "settled", makerFee: mkFee, takerFee: tkFee });
    }
    return { minted, outcomes };
  }

  clone(): Ledger {
    const l = new Ledger(this.p);
    for (const [k, a] of this.accounts) l.accounts.set(k, a.clone());
    l.settled = new Set(this.settled);
    l.sweepN = this.sweepN;
    l.fees = this.fees;
    return l;
  }
}

export function scoreAt(a: LedgerAccount, s: Micro, mint: Micro): Micro {
  return a.valueAt(s) - mint;
}

export const ONE: Micro = SCALE;
