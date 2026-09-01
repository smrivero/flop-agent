/**
 * Variable message length. Picked fresh before every turn so the conversation
 * doesn't settle into "always a paragraph" -- a max-token cap alone doesn't
 * prevent that, it just raises the ceiling every message grows toward. This
 * instead gives the model an explicit target character range each time, and
 * most of the time that range is short.
 */

export type ResponseMode = "ONE_LINER" | "SHORT" | "NORMAL" | "DETAILED" | "WILDCARD";

interface Weighted {
  mode: ResponseMode;
  weight: number;
}

// 20 / 30 / 30 / 15 / 5, in that order, as specified.
const WEIGHTS: Weighted[] = [
  { mode: "ONE_LINER", weight: 0.2 },
  { mode: "SHORT", weight: 0.3 },
  { mode: "NORMAL", weight: 0.3 },
  { mode: "DETAILED", weight: 0.15 },
  { mode: "WILDCARD", weight: 0.05 },
];

export function randomResponseMode(random: () => number = Math.random): ResponseMode {
  const r = random();
  let cumulative = 0;
  for (const { mode, weight } of WEIGHTS) {
    cumulative += weight;
    if (r < cumulative) return mode;
  }
  return WEIGHTS[WEIGHTS.length - 1].mode; // floating-point edge case at r ~= 1
}

const RANGES: Record<Exclude<ResponseMode, "WILDCARD">, { min: number; max: number }> = {
  ONE_LINER: { min: 40, max: 180 },
  SHORT: { min: 120, max: 350 },
  NORMAL: { min: 250, max: 700 },
  DETAILED: { min: 500, max: 1200 },
};

/**
 * The instruction block passed to the model for this turn -- always clamped to
 * `maxMessageChars` in case a deployment sets a tighter cap than a mode's
 * default range.
 */
export function responseModeInstruction(mode: ResponseMode, maxMessageChars: number): string {
  if (mode === "WILDCARD") {
    return (
      `RESPONSE MODE: WILDCARD\n` +
      `TARGET: no fixed length this time -- anywhere from a brutal one-sentence reply to a ` +
      `longer argument, your call. Stay under ${Math.min(1200, maxMessageChars)} characters.`
    );
  }
  const range = RANGES[mode];
  const max = Math.min(range.max, maxMessageChars);
  const min = Math.min(range.min, max);
  return `RESPONSE MODE: ${mode}\nTARGET: approximately ${min}-${max} characters. Respect it.`;
}
