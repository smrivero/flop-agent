/**
 * close-1 wire protocol: referee post parsing and (future) player message building.
 *
 * Referee posts: only the documented fields plus the ones observed live and verified
 * on 22/22 sweeps (seed: for, limits; price: applied, for, age_s; flow: omitted) are
 * parsed. Anything else is kept in `unknown` and logged, never interpreted. A post
 * is only trusted if it comes from the referee DID in the referee's own rooms.
 *
 * Player messages: the terms/accept signing strings below were verified against 64
 * real trades other agents posted (maker 64/64, taker 62/64 -- the 2 failures carry
 * taker "any" in the outer message, which is malformed). The signatures themselves
 * are NOT produced in this build: see signer.ts.
 */

import { randomBytes } from "node:crypto";
import { ceilTo, CENT, floorTo, fmt2, mul, parseAmount, toMicro, type Micro } from "./decimal.js";

export const REFEREE_DID = "did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte";
export const SEASON = "close-1";
export const REFEREE_ROOMS = ["d-close1-price", "d-close1-flow", "d-close1-positions", "d-close1-pnl", "d-close1-state"] as const;
export type RefereeRoom = (typeof REFEREE_ROOMS)[number];
export const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
export const TRADE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ------------------------------------------------------------------ referee posts

export interface RefTrade { px: string; tid: number | string; time: string }

export interface SeedPost { t: "seed"; season: string; price: string; trade: { tid: number | string; time: string }; package: string; rooms: string[]; limits?: [string, string]; for?: number; unknown: string[] }
export interface PricePost { t: "price"; n: number; ref: RefTrade; limits: [string, string]; global: string; file: string; applied?: string; for?: number; age_s?: number; unknown: string[] }
export interface FlowPost { t: "flow"; n: number; mints: string[]; rooms: string[]; settled: string[]; void: [string, string][]; missed: [string, number, number][]; file: string; omitted?: Record<string, number>; unknown: string[] }
export interface PositionsPost { t: "positions"; n: number; open: string; longs: number; shorts: number; top: [string, string][]; file: string; unknown: string[] }
export interface PnlPost { t: "pnl"; n: number; mark: string; top: [string, string][]; file: string; unknown: string[] }
export interface StatePost { t: "state"; n: number; root: string; owners: number; rooms: number; file: string; unknown: string[] }
export interface FinalPost { t: "final"; season: string; price: string; trade: { tid: number | string; time: string }; unknown: string[] }
export type RefereePost = SeedPost | PricePost | FlowPost | PositionsPost | PnlPost | StatePost | FinalPost;

const KNOWN: Record<string, string[]> = {
  seed: ["t", "season", "price", "trade", "package", "rooms", "limits", "for"],
  price: ["t", "n", "ref", "limits", "global", "file", "applied", "for", "age_s"],
  flow: ["t", "n", "mints", "rooms", "settled", "void", "missed", "file", "omitted"],
  positions: ["t", "n", "open", "longs", "shorts", "top", "file"],
  pnl: ["t", "n", "mark", "top", "file"],
  state: ["t", "n", "root", "owners", "rooms", "file"],
  final: ["t", "season", "price", "trade"],
};

const EXPECTED_ROOM: Record<string, RefereeRoom> = {
  seed: "d-close1-price", price: "d-close1-price", final: "d-close1-price", flow: "d-close1-flow",
  positions: "d-close1-positions", pnl: "d-close1-pnl", state: "d-close1-state",
};

export class RefereeParseError extends Error {}

function need<T>(cond: unknown, what: string): asserts cond {
  if (!cond) throw new RefereeParseError(what);
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isPrice = (v: unknown) => isStr(v) && /^\d+(\.\d{1,6})?$/.test(v);

/**
 * Parse one message read from a referee room. Returns null for anything that is not
 * a referee post (wrong author, not JSON, unknown type): those are ignored, never acted on.
 */
export function parseRefereePost(room: string, from: string, text: string): RefereePost | null {
  if (from !== REFEREE_DID) return null;
  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    o = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const t = o.t;
  if (!isStr(t) || !KNOWN[t]) return null;
  need(EXPECTED_ROOM[t] === room, `${t} post in unexpected room ${room}`);
  const unknown = Object.keys(o).filter((k) => !KNOWN[t].includes(k));
  switch (t) {
    case "seed": {
      need(o.season === SEASON && isPrice(o.price) && o.trade && isStr(o.package), "bad seed");
      return { t, season: SEASON, price: o.price as string, trade: o.trade as SeedPost["trade"], package: o.package as string,
        rooms: (o.rooms as string[]) ?? [], limits: o.limits as [string, string] | undefined, for: o.for as number | undefined, unknown };
    }
    case "price": {
      const ref = o.ref as RefTrade | undefined;
      need(isInt(o.n) && ref && isPrice(ref.px) && Array.isArray(o.limits) && o.limits.length === 2 && isStr(o.file), "bad price post");
      return { t, n: o.n as number, ref, limits: o.limits as [string, string], global: String(o.global), file: o.file as string,
        applied: o.applied as string | undefined, for: o.for as number | undefined, age_s: o.age_s as number | undefined, unknown };
    }
    case "flow": {
      need(isInt(o.n) && Array.isArray(o.mints) && Array.isArray(o.settled) && Array.isArray(o.void), "bad flow post");
      return { t, n: o.n as number, mints: o.mints as string[], rooms: (o.rooms as string[]) ?? [], settled: o.settled as string[],
        void: o.void as [string, string][], missed: (o.missed as [string, number, number][]) ?? [], file: String(o.file),
        omitted: o.omitted as Record<string, number> | undefined, unknown };
    }
    case "positions": {
      need(isInt(o.n) && isInt(o.longs) && isInt(o.shorts), "bad positions post");
      return { t, n: o.n as number, open: String(o.open), longs: o.longs as number, shorts: o.shorts as number,
        top: (o.top as [string, string][]) ?? [], file: String(o.file), unknown };
    }
    case "pnl": {
      need(isInt(o.n) && isPrice(o.mark), "bad pnl post");
      return { t, n: o.n as number, mark: o.mark as string, top: (o.top as [string, string][]) ?? [], file: String(o.file), unknown };
    }
    case "state": {
      need(isInt(o.n) && isInt(o.owners) && isInt(o.rooms) && isStr(o.root), "bad state post");
      return { t, n: o.n as number, root: o.root as string, owners: o.owners as number, rooms: o.rooms as number, file: String(o.file), unknown };
    }
    case "final": {
      need(isPrice(o.price), "bad final post");
      return { t, season: SEASON, price: o.price as string, trade: o.trade as FinalPost["trade"], unknown };
    }
  }
  return null;
}

// ------------------------------------------------------------------ limits

/** Limits the referee posts for the next sweep: [ceil(0.95*ref), floor(1.05*ref)] to the cent (22/22 live). */
export function limitsFor(ref: Micro, window: Micro): [Micro, Micro] {
  const lo = ceilTo(mul(ref, 1_000_000n - window), CENT);
  const hi = floorTo(mul(ref, 1_000_000n + window), CENT);
  return [lo, hi];
}

// ------------------------------------------------------------------ player messages (built, never signed here)

export interface Terms {
  id: string;
  maker: string;
  px: string;
  qty: string;
  side: "buy" | "sell";
  taker: string;
  until: number;
}

/** The terms JSON exactly as signed: sorted keys, no spaces (python json.dumps(sort_keys=True, separators=(",",":"))). */
export function canonicalTerms(terms: Terms): string {
  const keys = Object.keys(terms).sort() as (keyof Terms)[];
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(terms[k])}`).join(",") + "}";
}

export function makerSigningString(terms: Terms): string {
  return `${SEASON}|terms|${canonicalTerms(terms)}`;
}

export function takerSigningString(terms: Terms, takerDid: string): string {
  return `${SEASON}|accept|${canonicalTerms(terms)}|${takerDid}`;
}

/** The complete trade message: posted ONCE, only after both signatures exist. */
export function tradeMessageText(terms: Terms, takerDid: string, makerSig: string, takerSig: string): string {
  return `{"t":"trade","season":"${SEASON}","terms":${canonicalTerms(terms)},"taker":${JSON.stringify(takerDid)},` +
    `"maker_sig":${JSON.stringify(makerSig)},"taker_sig":${JSON.stringify(takerSig)}}`;
}

export function ownerMessageText(did: string): string {
  return `{"t":"owner","season":"${SEASON}","key":${JSON.stringify(did)}}`;
}

export function roomMessageText(room: string): string {
  return `{"t":"room","season":"${SEASON}","room":${JSON.stringify(room)}}`;
}

/** 128-bit cryptographically random trade id (32 hex chars; matches the fold's id shape). */
export function newTradeId(): string {
  return randomBytes(16).toString("hex");
}

export function termsFromTrade(t: { id: string; maker: string; side: "buy" | "sell"; qty: Micro; px: Micro; taker: string; until: number }): Terms {
  return { id: t.id, maker: t.maker, px: fmt2(t.px), qty: fmt2(t.qty), side: t.side, taker: t.taker, until: t.until };
}

export function microFromPost(px: string): Micro {
  const v = parseAmount(px);
  return v ?? toMicro(px);
}
