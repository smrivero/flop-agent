/**
 * Exact fixed-point arithmetic for close-1, in micro-units (1e-6) as BigInt.
 *
 * Why 1e-6 is exact: prices and quantities have at most 2 decimals, so qty*px has
 * 4, the 1% fee has 6, a clawback gap (close-px)*qty has 4, and every cash change
 * in the fold is one of those. The fold itself uses Decimal with 60 digits and
 * never rounds; this module reproduces it bit for bit (checked against the
 * vendored fold by ledger.test.ts). Anything that would need rounding throws.
 */

export type Micro = bigint;

export const SCALE = 1_000_000n;
export const CENT: Micro = 10_000n;
/** Same shape the fold accepts: close_call_fold.TWO_PLACES. */
export const TWO_PLACES = /^[0-9]{1,7}(\.[0-9]{1,2})?$/;

/** A price or quantity string as the fold's amount(): <= 2 decimals and > 0, else null. */
export function parseAmount(text: unknown): Micro | null {
  if (typeof text !== "string" || !TWO_PLACES.test(text)) return null;
  const v = toMicro(text);
  return v > 0n ? v : null;
}

/** Any decimal string (up to 6 places) to micro-units. */
export function toMicro(text: string): Micro {
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) throw new Error(`not a decimal with <= 6 places: ${JSON.stringify(text)}`);
  const frac = (m[3] ?? "").padEnd(6, "0");
  const v = BigInt(m[2]) * SCALE + BigInt(frac || "0");
  return m[1] ? -v : v;
}

export function fromNumber(x: number, places = 2): Micro {
  return toMicro(x.toFixed(places));
}

/** a*b for two micro values; throws if the result is not representable exactly. */
export function mul(a: Micro, b: Micro): Micro {
  const p = a * b;
  if (p % SCALE !== 0n) throw new Error(`inexact multiply ${fmt(a)} * ${fmt(b)}`);
  return p / SCALE;
}

export function min(a: Micro, b: Micro): Micro {
  return a < b ? a : b;
}

export function max(a: Micro, b: Micro): Micro {
  return a > b ? a : b;
}

export function abs(a: Micro): Micro {
  return a < 0n ? -a : a;
}

/** Floor to a multiple of `step` (e.g. CENT). */
export function floorTo(a: Micro, step: Micro): Micro {
  const r = ((a % step) + step) % step;
  return a - r;
}

export function ceilTo(a: Micro, step: Micro): Micro {
  const f = floorTo(a, step);
  return f === a ? a : f + step;
}

/** Decimal string with `places` decimals (trailing zeros kept), no rounding: throws if inexact. */
export function fmt(a: Micro, places = 6): string {
  const neg = a < 0n;
  const v = neg ? -a : a;
  const whole = v / SCALE;
  const frac = (v % SCALE).toString().padStart(6, "0");
  if (places < 6 && /[1-9]/.test(frac.slice(places))) throw new Error(`fmt would round ${whole}.${frac} to ${places}`);
  const out = places === 0 ? whole.toString() : `${whole}.${frac.slice(0, places)}`;
  return neg ? "-" + out : out;
}

/** The fold's wire format for px/qty: exactly 2 decimals. */
export function fmt2(a: Micro): string {
  return fmt(a, 2);
}

/** Plain decimal without trailing zeros (for logs and comparisons with fold output). */
export function fmtShort(a: Micro): string {
  const s = fmt(a, 6);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export function toNumber(a: Micro): number {
  return Number(a) / 1e6;
}
