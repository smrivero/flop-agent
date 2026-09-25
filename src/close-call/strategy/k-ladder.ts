/**
 * Strategy K (research/close-call/STRATEGY_ANALYSIS.md): a ladder on new extremes with
 * a split start and contrarian favoured pricing.
 *
 *  - first decision: pair 0 favours the long, pair 1 favours the short; lo = hi = estimate
 *  - later: estimate <= lo*(1-threshold) -> new pair favouring the LONG,  lo = estimate
 *           estimate >= hi*(1+threshold) -> new pair favouring the SHORT, hi = estimate
 *  - pair i = keys (2i+1, 2i+2): the first buys, the second sells
 *  - a pair whose trade is voided is retried at the next decisions (up to maxTries), repriced
 *  - nothing after the lock sweep
 *
 * Pure: no I/O, no clock. Implements the Strategy interface so it can be swapped.
 */

import type { StrategyKConfig } from "../config.js";

export type Favored = "long" | "short";
export type Trigger = "open-split-long" | "open-split-short" | "new-low" | "new-high" | "retry";

export interface StrategyIntent {
  pairIndex: number;
  favored: Favored;
  trigger: Trigger;
  triggerPx: number;
  level: { lo: number | null; hi: number | null };
  tries: number;
}

export interface DecisionInput {
  sweep: number;
  estimate: number;
  lockSweep: number;
  pairCount: number;
}

export interface KState {
  name: "K";
  started: boolean;
  lo: number | null;
  hi: number | null;
  nextPair: number;
  retries: { pairIndex: number; favored: Favored; tries: number; trigger: Trigger }[];
  inFlight: number[];
  triggers: number;
  exhaustedLogged: boolean;
}

export interface Strategy<S> {
  name: string;
  initial(): S;
  decide(state: S, input: DecisionInput): { state: S; intents: StrategyIntent[]; notes: string[] };
  onResult(state: S, pairIndex: number, favored: Favored, trigger: Trigger, tries: number, settled: boolean): S;
}

export const MAX_TRIES = 3;

export function strategyK(cfg: StrategyKConfig): Strategy<KState> {
  const x = cfg.threshold;
  return {
    name: "K",
    initial: () => ({ name: "K", started: false, lo: null, hi: null, nextPair: 0, retries: [], inFlight: [], triggers: 0, exhaustedLogged: false }),

    decide(prev, input) {
      const s: KState = JSON.parse(JSON.stringify(prev));
      const notes: string[] = [];
      const intents: StrategyIntent[] = [];
      if (input.sweep > input.lockSweep) return { state: s, intents, notes: ["after lock: no intents"] };
      const take = (favored: Favored, trigger: Trigger): boolean => {
        if (s.nextPair >= input.pairCount) {
          if (!s.exhaustedLogged) notes.push(`all ${input.pairCount} pairs used: trigger ${trigger} ignored`);
          s.exhaustedLogged = true;
          return false;
        }
        intents.push({ pairIndex: s.nextPair, favored, trigger, triggerPx: input.estimate, level: { lo: s.lo, hi: s.hi }, tries: 0 });
        s.inFlight.push(s.nextPair);
        s.nextPair++;
        return true;
      };
      for (const r of s.retries) {
        intents.push({ pairIndex: r.pairIndex, favored: r.favored, trigger: "retry", triggerPx: input.estimate, level: { lo: s.lo, hi: s.hi }, tries: r.tries });
        s.inFlight.push(r.pairIndex);
      }
      s.retries = [];
      if (!s.started) {
        s.started = true;
        s.lo = s.hi = input.estimate;
        s.triggers += 2;
        take("long", "open-split-long");
        take("short", "open-split-short");
        notes.push(`opening: lo=hi=${input.estimate}`);
        return { state: s, intents, notes };
      }
      if (s.lo !== null && input.estimate <= s.lo * (1 - x)) {
        notes.push(`new low ${input.estimate} <= ${s.lo} * (1 - ${x})`);
        s.lo = input.estimate;
        s.triggers++;
        take("long", "new-low");
      } else if (s.hi !== null && input.estimate >= s.hi * (1 + x)) {
        notes.push(`new high ${input.estimate} >= ${s.hi} * (1 + ${x})`);
        s.hi = input.estimate;
        s.triggers++;
        take("short", "new-high");
      }
      return { state: s, intents, notes };
    },

    onResult(prev, pairIndex, favored, trigger, tries, settled) {
      const s: KState = JSON.parse(JSON.stringify(prev));
      s.inFlight = s.inFlight.filter((p) => p !== pairIndex);
      if (!settled && tries + 1 < MAX_TRIES) s.retries.push({ pairIndex, favored, tries: tries + 1, trigger });
      return s;
    },
  };
}
