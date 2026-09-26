/**
 * Pure builders for the signed writes a future live mode would make. No key, no
 * signature and no network here: callers pass a Signer (live/signer.ts in live mode,
 * a test signer in tests) and a Transport (live/http-transport.ts or a mock).
 *
 *   signed message  POST /r/<room>        {"did","sig","nonce","text"}
 *                   signature over `<room>|<nonce>|<text after the single-line sweep>`
 *   signed note     POST /kv/<ns>/<key>   {"value","did","sig","nonce"[,"if_absent"]}
 *                   signature over `<ns>|<key>|<nonce>|<value after the sweep>`;
 *                   only ns = room-owners | room-allow accept signed writes, and the
 *                   nonce must exceed /kv/room-nonce/<room> (shared by both namespaces)
 *
 * Verified against the technocore-chat source (app.py note_post / room_post) and the
 * live manual. The POST lane is used for notes because a 99-DID allow-list (~5.6 KB)
 * is close to what a GET URL can carry.
 */

import { createHash } from "node:crypto";
import { makerSigningString, takerSigningString, tradeMessageText, TRADE_ID_RE, type Terms } from "./protocol.js";

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const NONCE_RE = /^[0-9]{1,19}$/;
export const SIG_RE = /^[A-Za-z0-9_-]{85}[AQgw]$/;
export const MAX_MESSAGE_CHARS = 4096;
export const MAX_NOTE_CHARS = 8192;
export const OWNERS_NS = "room-owners";
export const ALLOW_NS = "room-allow";
export const NONCE_NS = "room-nonce";

const SWEEP_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;
/** The server's single-line sweep, applied before signing (same rule as src/technocore.ts). */
export function sweepText(text: string): string {
  return text.replace(SWEEP_RE, " ").trim();
}

export interface Signer {
  readonly did: string;
  /** Ed25519 signature of `message` (UTF-8), base64url without padding (86 chars). */
  sign(message: string): string;
}

export interface SignedMessageBody { did: string; sig: string; nonce: string; text: string }
export interface SignedNoteBody { value: string; did: string; sig: string; nonce: string; if_absent?: boolean }

export function messageSigningString(room: string, nonce: string, text: string): string {
  return `${room}|${nonce}|${sweepText(text)}`;
}

export function noteSigningString(ns: string, key: string, nonce: string, value: string): string {
  return `${ns}|${key}|${nonce}|${sweepText(value)}`;
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function buildSignedMessage(signer: Signer, room: string, nonce: string, text: string): { path: string; body: SignedMessageBody } {
  check(NAME_RE.test(room), `bad room name ${room}`);
  check(NONCE_RE.test(nonce), `bad nonce ${nonce}`);
  const swept = sweepText(text);
  check(swept.length > 0 && swept.length <= MAX_MESSAGE_CHARS, `message must be 1..${MAX_MESSAGE_CHARS} chars after the sweep`);
  const sig = signer.sign(messageSigningString(room, nonce, swept));
  check(SIG_RE.test(sig), "signer returned a malformed signature");
  return { path: `/r/${room}`, body: { did: signer.did, sig, nonce, text: swept } };
}

export function buildSignedNote(signer: Signer, ns: typeof OWNERS_NS | typeof ALLOW_NS, key: string, nonce: string, value: string,
  opts: { ifAbsent?: boolean } = {}): { path: string; body: SignedNoteBody } {
  check(NAME_RE.test(key) && key.startsWith("d-"), `only d- rooms are ownable: ${key}`);
  check(NONCE_RE.test(nonce), `bad nonce ${nonce}`);
  const swept = sweepText(value);
  check(swept.length > 0 && swept.length <= MAX_NOTE_CHARS, `note value must be 1..${MAX_NOTE_CHARS} chars`);
  const sig = signer.sign(noteSigningString(ns, key, nonce, swept));
  check(SIG_RE.test(sig), "signer returned a malformed signature");
  const body: SignedNoteBody = { value: swept, did: signer.did, sig, nonce };
  if (opts.ifAbsent) body.if_absent = true;
  return { path: `/kv/${ns}/${key}`, body };
}

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// ------------------------------------------------------------------ trades (both signatures, then ONE message)


export interface SignedTrade { terms: Terms; makerSig: string; takerSig: string; text: string }

/**
 * Maker signs `close-1|terms|<canonical terms>`, taker signs `close-1|accept|<canonical terms>|<taker did>`
 * (both verified against 64 real trades, protocol.test.ts). We always name the taker: a "taker":"any"
 * trade could be countersigned by anyone who sees it.
 */
export function buildSignedTrade(maker: Signer, taker: Signer, terms: Terms): SignedTrade {
  check(TRADE_ID_RE.test(terms.id), `bad trade id ${terms.id}`);
  check(terms.maker === maker.did, "terms.maker is not the maker signer's did");
  check(terms.taker === taker.did, "terms.taker must name our taker key (never \"any\")");
  check(terms.side === "buy" || terms.side === "sell", "side must be buy | sell");
  check(/^\d+\.\d{2}$/.test(terms.px) && /^\d+\.\d{2}$/.test(terms.qty), "px and qty must have exactly two decimals");
  check(Number(terms.qty) >= 0.1, "qty must be at least 0.10");
  check(Number.isInteger(terms.until) && terms.until > 0, "until must be a sweep number");
  const makerSig = maker.sign(makerSigningString(terms));
  const takerSig = taker.sign(takerSigningString(terms, taker.did));
  check(SIG_RE.test(makerSig) && SIG_RE.test(takerSig), "signer returned a malformed signature");
  const text = tradeMessageText(terms, taker.did, makerSig, takerSig);
  check(text.length <= MAX_MESSAGE_CHARS, "trade message exceeds the message cap");
  return { terms, makerSig, takerSig, text };
}
