/**
 * LIVE ONLY. One-time import of the referee's seed post into the live DB.
 *
 * The seed is message #1 of d-close1-price; technocore's ring has rotated past it, so a live DB created
 * later can never observe it (the paper DB did, on 25 Sep). This copies ONLY that raw message, from the
 * paper DB opened read-only, after verifying it on its own merits -- the paper DB is not trusted:
 *   - exactly one distinct seed message in the source;
 *   - signed by the referee: from = REFEREE_DID and Ed25519 over `<room>|<nonce>|<text>` (technocore's scheme);
 *   - it parses as a close-1 seed; its package = the pinned manifest hash; the vendored package verifies;
 *   - the contest loaded from the vendor is close-1.
 * It is then ingested through the observer's own path (raw_posts + seed), exactly as if it had been read live.
 * Nothing else is read or copied (no keys, trades, positions, book, nonces, strategy, rooms, alerts).
 *
 * Idempotent: an identical seed already in the live DB -> nothing. A DIFFERENT one -> refused (never overwritten).
 * Provenance (source, seq, sha256 of the text, signature, checks) is kept in meta `seed_import`.
 */

import { createHash } from "node:crypto";
import { verifyEd25519 } from "../../identity.js";
import type { Contest } from "../contest.js";
import { REFEREE_PACKAGE_SHA256, verifyVendor } from "../fold.js";
import { ccLog } from "../logger.js";
import { openReadonly } from "../monitor.js";
import { RefereeObserver } from "../observer.js";
import { parseRefereePost, REFEREE_DID, type SeedPost } from "../protocol.js";
import { messageSigningString } from "../protocol-writes.js";
import { getMeta, now, setMeta, type CcDb } from "../store.js";

export const SEED_ROOM = "d-close1-price";

export class SeedImportRefused extends Error {}

interface RawSeed { room: string; seq: number; generation: number; ts: string | null; from_did: string | null; text: string; nonce: string | null; sig: string | null }

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Verify a raw seed message on its own merits (throws SeedImportRefused with the reason). */
export function verifySeedMessage(m: RawSeed, contest: Contest, vendorRoot: string): SeedPost {
  const refuse = (why: string): never => { throw new SeedImportRefused(`seed #${m.seq}: ${why}`); };
  if (m.room !== SEED_ROOM) refuse(`room ${m.room}, expected ${SEED_ROOM}`);
  if (m.from_did !== REFEREE_DID) refuse(`from ${m.from_did}, expected the referee ${REFEREE_DID}`);
  if (!m.sig || !m.nonce) refuse("no signature/nonce stored with the message: cannot verify it");
  if (!verifyEd25519(REFEREE_DID, m.sig!, messageSigningString(SEED_ROOM, m.nonce!, m.text))) refuse("the referee's signature does NOT verify");
  const post = parseRefereePost(SEED_ROOM, m.from_did!, m.text);
  if (!post || post.t !== "seed") refuse("does not parse as a seed post");
  const seed = post as SeedPost;
  if (seed.season !== "close-1") refuse(`season ${seed.season}, expected close-1`);
  if (seed.package !== REFEREE_PACKAGE_SHA256) refuse(`package ${seed.package}, expected the pinned ${REFEREE_PACKAGE_SHA256}`);
  if (contest.contestId !== "close-1") refuse(`vendored contest is ${contest.contestId}, expected close-1`);
  verifyVendor(vendorRoot);                                      // throws on a manifest/fold mismatch
  return seed;
}

export interface SeedImportResult {
  action: "imported" | "identical";
  seq: number; ts: string | null; price: string; package: string; text_sha256: string;
}

export function importSeed(liveDb: CcDb, paperDbPath: string, contest: Contest, vendorRoot: string): SeedImportResult {
  const src = openReadonly(paperDbPath);
  if (!src.db) throw new SeedImportRefused(`cannot open the paper DB read-only: ${src.error}`);
  let rows: RawSeed[];
  try {
    rows = src.db.prepare(`SELECT room, seq, generation, ts, from_did, text, nonce, sig FROM raw_posts
      WHERE room = ? AND text LIKE '%"t":"seed"%' ORDER BY seq`).all(SEED_ROOM) as RawSeed[];
  } finally {
    src.db.close();
  }
  const distinct = new Set(rows.map((r) => `${r.text}|${r.sig}`));
  if (distinct.size === 0) throw new SeedImportRefused(`no seed message in ${paperDbPath}`);
  if (distinct.size > 1) throw new SeedImportRefused(`${distinct.size} DIFFERENT seed messages in ${paperDbPath}: not choosing one`);
  const m = rows[0];
  const seed = verifySeedMessage(m, contest, vendorRoot);
  const out = { seq: m.seq, ts: m.ts, price: seed.price, package: seed.package, text_sha256: sha(m.text) };

  // What the live DB already holds: identical -> nothing; different -> refused, never overwritten.
  const liveSeed = liveDb.prepare("SELECT json FROM seed WHERE id = 1").get() as { json: string | null } | undefined;
  const liveRaw = liveDb.prepare(`SELECT text, sig FROM raw_posts WHERE room = ? AND text LIKE '%"t":"seed"%'`).all(SEED_ROOM) as { text: string; sig: string | null }[];
  if (liveSeed || liveRaw.length) {
    const same = liveSeed?.json === m.text && liveRaw.length > 0 && liveRaw.every((r) => r.text === m.text && r.sig === m.sig);
    if (same) return { action: "identical", ...out };
    throw new SeedImportRefused(`the live DB already holds a DIFFERENT seed (seed row ${liveSeed ? sha(liveSeed.json ?? "").slice(0, 12) : "none"}, ${liveRaw.length} raw): not overwriting`);
  }

  liveDb.transaction(() => {
    new RefereeObserver(liveDb, "http://unused.invalid", null).ingest(SEED_ROOM, m.generation, {
      seq: m.seq, ts: m.ts ?? "", from: m.from_did!, text: m.text, nonce: m.nonce!, sig: m.sig!,
    });
    const stored = liveDb.prepare("SELECT package, json FROM seed WHERE id = 1").get() as { package: string; json: string } | undefined;
    if (stored?.json !== m.text) throw new SeedImportRefused("the observer did not record the seed as expected: rolled back");
    setMeta(liveDb, "seed_import", JSON.stringify({
      source: paperDbPath, source_opened: "read-only", room: SEED_ROOM, seq: m.seq, generation: m.generation, ts: m.ts, nonce: m.nonce,
      sig: m.sig, from: m.from_did, text_sha256: out.text_sha256, price: seed.price, package: seed.package,
      checks: ["one distinct seed", "from = referee DID", "referee Ed25519 signature", "season close-1", "package = pinned", "vendor verified", "contest close-1"],
      imported_at: now(),
    }));
  })();
  ccLog("PRICE", { kind: "seed-import", seq: m.seq, price: seed.price, package: seed.package.slice(0, 12), text_sha256: out.text_sha256.slice(0, 16), source: paperDbPath },
    "referee seed imported (verified signature; nothing else copied)");
  return { action: "imported", ...out };
}

export function seedImportProvenance(db: CcDb): unknown {
  const raw = getMeta(db, "seed_import");
  return raw ? JSON.parse(raw) : null;
}
