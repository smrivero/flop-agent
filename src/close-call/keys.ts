/**
 * Key inventory CC001..CC100.
 *
 * In this build every key is FAKE: a syntactically valid did:key derived from
 * sha256("close-call-paper|<id>") with no private key behind it (fake = 1 in the
 * table). Loading real key files is deliberately not implemented: loadRealKey()
 * throws. Balances are never stored here -- cash, position, lots, fees and score
 * always come from replaying trades through the official fold (see paper.ts).
 */

import { createHash } from "node:crypto";
import { DID_RE } from "./protocol.js";
import { now, type CcDb } from "./store.js";

/**
 * Key lifecycle. Every change goes through transitionKey(), which only allows these edges:
 *
 *   UNUSED -> GENERATED -> REGISTER_PENDING -> MINT_EXPECTED -> PROBE_PENDING -> MINT_CONFIRMED -> READY -> ACTIVE
 *                                        \________________\______________________/^
 *   (REGISTER_PENDING and MINT_EXPECTED may go straight to MINT_CONFIRMED; PROBE_PENDING may fall back to
 *    REGISTER_PENDING when a probe proves the key was not minted; any state -> ERROR)
 *
 * MINT_EXPECTED is information ("everything public says it should be minted"), never permission to trade.
 * MINT_CONFIRMED requires evidence the CONFIGURED POLICY accepts (see POLICY_ACCEPTS). Only READY/ACTIVE
 * keys can be used by the strategy; PROBE_PENDING keys can only be used by the mint probe.
 */
export type KeyStatus = "UNUSED" | "GENERATED" | "REGISTER_PENDING" | "MINT_EXPECTED" | "PROBE_PENDING" | "MINT_CONFIRMED" | "READY" | "ACTIVE" | "ERROR";
export const KEY_STATUSES: KeyStatus[] = ["UNUSED", "GENERATED", "REGISTER_PENDING", "MINT_EXPECTED", "PROBE_PENDING", "MINT_CONFIRMED", "READY", "ACTIVE", "ERROR"];
export const TRADABLE: readonly KeyStatus[] = ["READY", "ACTIVE"];
const KEY_EDGES: Record<KeyStatus, KeyStatus[]> = {
  UNUSED: ["GENERATED", "ERROR"],
  GENERATED: ["REGISTER_PENDING", "ERROR"],
  REGISTER_PENDING: ["MINT_EXPECTED", "PROBE_PENDING", "MINT_CONFIRMED", "ERROR"],
  MINT_EXPECTED: ["PROBE_PENDING", "MINT_CONFIRMED", "ERROR"],
  PROBE_PENDING: ["MINT_CONFIRMED", "REGISTER_PENDING", "ERROR"],
  MINT_CONFIRMED: ["READY", "ERROR"],
  READY: ["ACTIVE", "ERROR"],
  ACTIVE: ["ERROR"],
  ERROR: [],
};

/**
 * Evidence about a mint:
 *   flow.mints        the DID is listed in a d-close1-flow post's `mints` (explicit referee statement)
 *   room-acceptance   a room registered by this DID was listed in flow.rooms (the referee only lists rooms
 *                     registered by owners -- observed 25 Sep: 13/13 non-owner registrations unlisted, 3/3
 *                     owner ones listed; flow.rooms is never truncated)
 *   protocol          a signed owner message, in a registered room, stamped before a sweep the referee has
 *                     published, outside every missed range, with no contrary evidence
 *   probe             a probe trade of ours involving the DID is listed in flow.settled
 *   paper-fold        the official fold minted it in the PAPER book (fake keys only)
 */
export type EvidenceSource = "flow.mints" | "room-acceptance" | "protocol" | "probe" | "paper-fold";
export interface MintEvidence { source: EvidenceSource; sweep: number; detail: string }
export type ConfirmationPolicyName = "STRICT" | "PROTOCOL" | "PROBE";
export const POLICY_ACCEPTS: Record<ConfirmationPolicyName, readonly EvidenceSource[]> = {
  STRICT: ["flow.mints"],
  PROTOCOL: ["flow.mints", "room-acceptance", "protocol"],
  PROBE: ["flow.mints", "room-acceptance", "probe"],
};

export class IllegalTransition extends Error {}
export type StrategyRole = "long*" | "short*" | "long" | "short" | null;

export interface KeyRecord {
  id: string;
  did: string;
  key_path: string | null;
  fake: number;
  registered: number;
  minted: number;
  minted_sweep: number | null;
  mint_evidence: string | null;
  probe_trade_id?: string | null;
  status: KeyStatus;
  strategy_role: StrategyRole;
  pair_index: number | null;
  entry_reference: string | null;
  entry_sweep: number | null;
  entry_px: string | null;
  error: string | null;
}

/** What a key looks like once the fold's numbers are attached (status/report view). */
export interface KeyView extends KeyRecord {
  cash: string;
  position: string;
  lots: [string, string][];
  fees: string;
  realized_pnl: string;
  mark_pnl: string;
  score: string;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function keyId(i: number, prefix = "CC"): string {
  return `${prefix}${String(i).padStart(3, "0")}`;
}

/** Deterministic, unique, VALID-shaped did:key for paper trading only. There is no private key for it. */
export function paperDid(id: string): string {
  let n = BigInt("0x" + createHash("sha256").update(`close-call-paper|${id}`).digest("hex"));
  let body = "";
  for (let i = 0; i < 44; i++) {
    body += B58[Number(n % 58n)];
    n /= 58n;
  }
  const did = "did:key:z6Mk" + body;
  if (!DID_RE.test(did)) throw new Error(`paperDid produced an invalid did for ${id}`);
  return did;
}

export function ensurePaperKeys(db: CcDb, count: number, prefix = "CC"): KeyRecord[] {
  const real = db.prepare("SELECT COUNT(*) AS n FROM keys WHERE fake = 0").get() as { n: number };
  if (real.n > 0) throw new Error("the key table holds real keys; paper mode refuses to mix them");
  const ins = db.prepare(`INSERT OR IGNORE INTO keys (id, did, key_path, fake, status, updated_at) VALUES (?, ?, NULL, 1, 'GENERATED', ?)`);
  for (let i = 1; i <= count; i++) {
    const id = keyId(i, prefix);
    ins.run(id, paperDid(id), now());
  }
  return listKeys(db).slice(0, count);
}

export function listKeys(db: CcDb): KeyRecord[] {
  return db.prepare("SELECT * FROM keys ORDER BY id").all() as KeyRecord[];
}

export function getKey(db: CcDb, id: string): KeyRecord {
  const k = db.prepare("SELECT * FROM keys WHERE id = ?").get(id) as KeyRecord | undefined;
  if (!k) throw new Error(`unknown key ${id}`);
  return k;
}

/** The only way a key's status changes. Throws on an edge that is not allowed or on missing evidence. */
export function transitionKey(db: CcDb, id: string, to: KeyStatus,
  opts: { evidence?: MintEvidence; reason?: string; patch?: Partial<KeyRecord>; policy?: ConfirmationPolicyName } = {}): KeyRecord {
  const k = getKey(db, id);
  if (k.status === to) return k;
  if (!KEY_EDGES[k.status].includes(to)) throw new IllegalTransition(`${id}: ${k.status} -> ${to} is not allowed`);
  const patch: Partial<KeyRecord> = { ...(opts.patch ?? {}), status: to };
  if (to === "REGISTER_PENDING") patch.registered = 1;
  if (to === "MINT_CONFIRMED") {
    const e = opts.evidence;
    if (!e) throw new IllegalTransition(`${id}: MINT_CONFIRMED needs explicit referee evidence`);
    if (e.source === "paper-fold") {
      if (k.fake !== 1) throw new IllegalTransition(`${id}: paper evidence cannot confirm a real key`);
    } else if (!POLICY_ACCEPTS[opts.policy ?? "STRICT"].includes(e.source)) {
      throw new IllegalTransition(`${id}: policy ${opts.policy ?? "STRICT"} does not accept ${e.source} evidence`);
    }
    patch.minted = 1;
    patch.minted_sweep = e.sweep;
    patch.mint_evidence = JSON.stringify(e);
  }
  if (to === "MINT_EXPECTED" && !opts.evidence) throw new IllegalTransition(`${id}: MINT_EXPECTED needs the protocol evidence that justifies it`);
  if (to === "MINT_EXPECTED") patch.mint_evidence = JSON.stringify(opts.evidence);
  if (to === "ERROR") patch.error = opts.reason ?? "unspecified";
  updateKey(db, id, patch);
  return getKey(db, id);
}

export function isTradable(status: string | undefined): boolean {
  return !!status && (TRADABLE as readonly string[]).includes(status);
}

/** Explicit mint evidence for `did` in the stored referee flow posts, if any. */
export function findMintEvidence(db: CcDb, did: string, allowSettledProbe = false): MintEvidence | null {
  const rows = db.prepare("SELECT text FROM raw_posts WHERE room = 'd-close1-flow' AND text LIKE ? ORDER BY seq").all(`%${did}%`) as { text: string }[];
  for (const r of rows) {
    const f = JSON.parse(r.text) as { n: number; mints?: string[] };
    if (f.mints?.includes(did)) return { source: "flow.mints", sweep: f.n, detail: "DID listed in flow.mints" };
  }
  if (allowSettledProbe) {
    const t = db.prepare(`SELECT i.trade_id, s.n FROM intents i JOIN settled_ids s ON s.id = i.trade_id
      WHERE i.maker_did = ? OR i.taker_did = ? ORDER BY s.n LIMIT 1`).get(did, did) as { trade_id: string; n: number } | undefined;
    if (t) return { source: "probe", sweep: t.n, detail: `our trade ${t.trade_id} listed in flow.settled` };
  }
  return null;
}

/** Low-level column update. Status must go through transitionKey(). */
export function updateKey(db: CcDb, id: string, patch: Partial<Omit<KeyRecord, "id" | "did" | "fake">>): void {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  db.prepare(`UPDATE keys SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...cols.map((c) => (patch as Record<string, unknown>)[c] as never), now(), id);
}

export function keyStatusCounts(db: CcDb): Record<string, number> {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM keys GROUP BY status").all() as { status: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export class RealKeysNotAvailable extends Error {}

/** Real keys are not part of this build. Kept as an explicit stop so no code path can pretend otherwise. */
export function loadRealKey(_path: string): never {
  throw new RealKeysNotAvailable("real key loading is not implemented in this build (paper/observe only)");
}

/**
 * The signer this build ships: it never signs. It returns what WOULD be signed so
 * paper logs show the exact bytes a real signer will need.
 */
export function wouldSign(did: string, message: string): { did: string; would_sign: string; sha256: string; signature: null } {
  return { did, would_sign: message, sha256: createHash("sha256").update(message, "utf8").digest("hex"), signature: null };
}
