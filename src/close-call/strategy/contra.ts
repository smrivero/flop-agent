/**
 * CONTRA: take profit on a move in the champion's favour and reverse (research/close-call/contra-analysis.ts).
 * A module separate from Strategy K: its own keys, its own state ('CONTRA' in strategy_state), its own intents.
 *
 *  - two champions: one starts LONG, one starts SHORT; each owns a fixed list of counterparties
 *  - flat champion -> open in the wanted direction, anchor = the estimate at that decision
 *  - long  and estimate >= anchor*(1+x) -> CLOSE (sell the position) + REOPEN short, anchor = estimate
 *  - short and estimate <= anchor*(1-x) -> CLOSE (buy back)          + REOPEN long,  anchor = estimate
 *  - every leg uses the next counterparty, consumed when the leg is DECIDED (persisted before any POST), never
 *    reused -- not even when the leg is later voided or not sent
 *  - a flip needs two counterparties; with fewer left the champion HOLDS its position until S (exhausted)
 *  - nothing while a champion still has a leg awaiting settlement; nothing after the lock
 *
 * Pure: no I/O, no clock. The champion's position comes from the book (settled trades only).
 */

import type { Favored } from "./k-ladder.js";

export type ContraLeg = "open" | "close" | "reopen";
export type Dir = 1 | -1;

export interface ChampionSpec { name: "long" | "short"; startDir: Dir; champion: string; counterparties: string[] }

export interface ChampionState {
  name: "long" | "short";
  champion: string;
  startDir: Dir;
  /** Direction of the next open (the start direction, then the side of the last reversal). */
  want: Dir;
  /** Estimate at the last open/reversal decision: the move is measured from here. */
  anchor: number | null;
  /** Index of the next unused counterparty. */
  next: number;
  flips: number;
  legs: number;
  /** Intent ids of legs decided and not yet resolved (settled, voided or not sent). */
  pending: string[];
  exhausted: boolean;
}

export interface ContraState { name: "CONTRA"; champions: ChampionState[]; decisions: number }

export interface ContraIntent {
  champion: "long" | "short";
  leg: ContraLeg;
  /** The champion's side in THIS trade: +1 it buys, -1 it sells. The champion is always the favoured side. */
  dir: Dir;
  favored: Favored;
  championId: string;
  counterpartyId: string;
  /** Close legs sell/buy back at most the champion's position (contract micro-units as a decimal string). */
  qtyCap: string | null;
  estimate: number;
}

export interface ContraInput {
  sweep: number;
  estimate: number;
  lockSweep: number;
  /** Champion key id -> signed position in micro-units (settled book). */
  positions: Record<string, bigint>;
}

export function contraSpecs(keys: string[], counterparties: number): ChampionSpec[] {
  if (keys.length !== 2 * (1 + counterparties)) throw new Error(`CONTRA needs ${2 * (1 + counterparties)} keys, got ${keys.length}`);
  const half = 1 + counterparties;
  return [
    { name: "long", startDir: 1, champion: keys[0], counterparties: keys.slice(1, half) },
    { name: "short", startDir: -1, champion: keys[half], counterparties: keys.slice(half + 1) },
  ];
}

export function contraInitial(specs: ChampionSpec[]): ContraState {
  return {
    name: "CONTRA", decisions: 0,
    champions: specs.map((s) => ({ name: s.name, champion: s.champion, startDir: s.startDir, want: s.startDir, anchor: null, next: 0, flips: 0, legs: 0, pending: [], exhausted: false })),
  };
}

const fav = (dir: Dir): Favored => (dir > 0 ? "long" : "short");

export function contraDecide(prev: ContraState, specs: ChampionSpec[], threshold: number, input: ContraInput): { state: ContraState; intents: ContraIntent[]; notes: string[] } {
  const s: ContraState = JSON.parse(JSON.stringify(prev));
  const intents: ContraIntent[] = [];
  const notes: string[] = [];
  if (input.sweep > input.lockSweep) return { state: s, intents, notes: ["after lock: no CONTRA intents"] };
  s.decisions++;
  for (const c of s.champions) {
    const spec = specs.find((x) => x.name === c.name)!;
    if (spec.champion !== c.champion) throw new Error(`CONTRA ${c.name}: champion ${c.champion} in state, ${spec.champion} configured`);
    if (c.pending.length) { notes.push(`${c.name}: ${c.pending.length} leg(s) awaiting settlement`); continue; }
    const pos = input.positions[c.champion] ?? 0n;
    const e = input.estimate;
    const cps = spec.counterparties;
    if (pos === 0n) {
      if (c.next >= cps.length) {
        if (!c.exhausted) notes.push(`${c.name}: flat and no counterparty left`);
        c.exhausted = true;
        continue;
      }
      intents.push({ champion: c.name, leg: c.legs === 0 ? "open" : "reopen", dir: c.want, favored: fav(c.want), championId: c.champion, counterpartyId: cps[c.next], qtyCap: null, estimate: e });
      c.next++; c.legs++; c.anchor = e;
      continue;
    }
    const long = pos > 0n;
    if (c.anchor === null) c.anchor = e;                            // restart with a position and no anchor: measure from now
    const take = long ? e >= c.anchor * (1 + threshold) : e <= c.anchor * (1 - threshold);
    if (!take) continue;
    if (c.next + 2 > cps.length) {
      if (!c.exhausted) notes.push(`${c.name}: take-profit at ${e} but only ${cps.length - c.next} counterparty left: holding ${long ? "long" : "short"} until S`);
      c.exhausted = true;
      continue;
    }
    const dir: Dir = long ? -1 : 1;
    const abs = long ? pos : -pos;
    intents.push({ champion: c.name, leg: "close", dir, favored: fav(dir), championId: c.champion, counterpartyId: cps[c.next], qtyCap: abs.toString(), estimate: e });
    intents.push({ champion: c.name, leg: "reopen", dir, favored: fav(dir), championId: c.champion, counterpartyId: cps[c.next + 1], qtyCap: null, estimate: e });
    c.next += 2; c.legs += 2; c.flips++; c.want = dir; c.anchor = e;
  }
  return { state: s, intents, notes };
}

/** The engine persisted a decided leg under `intentId` (before any POST). */
export function contraPending(state: ContraState, champion: "long" | "short", intentId: string): ContraState {
  const s: ContraState = JSON.parse(JSON.stringify(state));
  s.champions.find((c) => c.name === champion)!.pending.push(intentId);
  return s;
}

/** A leg is resolved (settled, voided, not applied or not sent): the champion may decide again. */
export function contraResolved(state: ContraState, intentId: string): ContraState {
  const s: ContraState = JSON.parse(JSON.stringify(state));
  for (const c of s.champions) c.pending = c.pending.filter((id) => id !== intentId);
  return s;
}

/** Every key CONTRA has ever given a leg to (never to be reused). */
export function contraUsedKeys(state: ContraState, specs: ChampionSpec[]): Set<string> {
  const used = new Set<string>();
  for (const c of state.champions) {
    const spec = specs.find((x) => x.name === c.name)!;
    if (c.legs > 0) used.add(spec.champion);
    for (let i = 0; i < c.next; i++) used.add(spec.counterparties[i]);
  }
  return used;
}
