import { rolloverDayIfNeeded } from "./state.js";
import type { DebateState } from "./types.js";

/**
 * Whether another message may be generated today. Rolls the day over first
 * (a pure, idempotent check -- callers still persist the rolled-over state
 * themselves via recordTurn, this never writes anything) so a turn running
 * right after UTC midnight sees a correctly-reset counter rather than
 * yesterday's leftover count.
 */
export function canPublishToday(state: DebateState, maxMessagesPerDay: number, now: Date = new Date()): boolean {
  const rolled = rolloverDayIfNeeded(state, now);
  return rolled.messagesToday < maxMessagesPerDay;
}
