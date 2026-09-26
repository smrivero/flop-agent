/**
 * The OFFICIAL fold, run as-is: vendor/technocore-close-call/close_call_fold.py through
 * fold_bridge.py in a long-lived python3 child process.
 *
 * Before anything else, verifyVendor() checks sha256(manifest.json) against the hash the
 * referee pinned in its live seed message and sha256(close_call_fold.py) against the
 * manifest. On any mismatch it throws and the caller must stop (no fold, no strategy).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { WireTrade } from "./ledger.js";

export const REFEREE_PACKAGE_SHA256 = "bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa";
const HERE = dirname(fileURLToPath(import.meta.url));

export class FoldIntegrityError extends Error {}

export interface VendorCheck {
  manifestSha256: string;
  foldSha256: string;
  foldBytes: number;
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

export function verifyVendor(vendorRoot: string, pinned = REFEREE_PACKAGE_SHA256): VendorCheck {
  const manifestBuf = readFileSync(join(vendorRoot, "manifest.json"));
  const manifestSha256 = sha256(manifestBuf);
  if (manifestSha256 !== pinned) {
    throw new FoldIntegrityError(`manifest.json sha256 ${manifestSha256} != referee seed package ${pinned}`);
  }
  const manifest = JSON.parse(manifestBuf.toString("utf8"));
  for (const [path, meta] of Object.entries(manifest.files as Record<string, { sha256: string; bytes: number }>)) {
    const buf = readFileSync(join(vendorRoot, path));
    if (sha256(buf) !== meta.sha256 || buf.length !== meta.bytes) {
      throw new FoldIntegrityError(`${path} does not match manifest.json (sha256/bytes)`);
    }
  }
  const fold = readFileSync(join(vendorRoot, "close_call_fold.py"));
  return { manifestSha256, foldSha256: sha256(fold), foldBytes: fold.length };
}

export interface FoldSweepResult {
  sweep: number;
  reference: string;
  close: string;
  minted: string[];
  trades: { id: string | null; outcome: "settled" | "void"; reason?: string; maker_fee?: string; taker_fee?: string }[];
  global_price: string;
}

export interface FoldAccount { cash: string; fees: string; position: string; lots: [string, string][]; value: string | null }

export class OfficialFold {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private rid = 0;
  private closed = false;

  private constructor(python: string, vendorRoot: string) {
    this.child = spawn(python, [join(HERE, "fold_bridge.py"), vendorRoot], { stdio: ["pipe", "pipe", "pipe"] });
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      const msg = JSON.parse(line) as { rid: number; ok: boolean; result?: unknown; error?: string };
      const p = this.pending.get(msg.rid);
      if (!p) return;
      this.pending.delete(msg.rid);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(`fold: ${msg.error}`));
    });
    let stderr = "";
    this.child.stderr.on("data", (d) => (stderr += d));
    this.child.on("exit", (code) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`fold bridge exited (${code}): ${stderr.slice(-500)}`));
      this.pending.clear();
    });
  }

  /** Verifies the vendored package, starts the bridge and checks it imported the same file. */
  static async start(python: string, vendorRoot: string, config?: Record<string, unknown>): Promise<OfficialFold & { vendor: VendorCheck }> {
    const vendor = verifyVendor(vendorRoot);
    const fold = new OfficialFold(python, vendorRoot) as OfficialFold & { vendor: VendorCheck };
    const h = (await fold.call({ op: "hash" })) as { sha256: string };
    if (h.sha256 !== vendor.foldSha256) {
      fold.stop();
      throw new FoldIntegrityError(`bridge imported a fold with sha256 ${h.sha256}, expected ${vendor.foldSha256}`);
    }
    fold.vendor = vendor;
    await fold.call({ op: "reset", config: config ?? null });
    return fold;
  }

  call(req: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("fold bridge is closed"));
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      this.pending.set(rid, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ ...req, rid }) + "\n");
    });
  }

  reset(config?: Record<string, unknown>) { return this.call({ op: "reset", config: config ?? null }); }
  seed(px: string) { return this.call({ op: "seed", px }); }
  sweep(n: number, ref: string, close: string, owners: string[], trades: WireTrade[]) {
    return this.call({ op: "sweep", n, ref, close, owners, trades }) as Promise<FoldSweepResult>;
  }
  check(n: number, ref: string, close: string, owners: string[], trades: WireTrade[]) {
    return this.call({ op: "check", n, ref, close, owners, trades }) as Promise<FoldSweepResult>;
  }
  accounts(keys: string[] | null, mark?: string) {
    return this.call({ op: "accounts", keys, mark: mark ?? null }) as Promise<{ accounts: Record<string, FoldAccount>; sweep_n: number; fees: string; settled: number }>;
  }
  final(px: string) { return this.call({ op: "final", px }); }

  stop(): void {
    if (!this.closed) this.child.stdin.end();
    this.closed = true;
  }
}

/** One staging trade between two of our keys, replayed alone in the official fold (bootstrap.ts `foldTest`). */
export interface IsolatedTradeInput { sweep: number; ref: string; close: string; owners: string[]; trade: WireTrade }
export interface IsolatedTradeResult { outcome: "settled" | "void"; reason: string | null; accounts: Record<string, FoldAccount> }
export type IsolatedTradeFold = ((p: IsolatedTradeInput) => Promise<IsolatedTradeResult>) & { stop: () => void };

/**
 * The trade only touches our two accounts, so its outcome is decided by the fold on those inputs alone: both
 * keys minted one sweep before (10,000 POLF, flat), then the trade at the referee's published ref/close.
 * Same evidence the live strategy trades settle on; the referee's truncated lists are only a cross-check.
 */
export function isolatedTradeFold(python: string, vendorRoot: string, config: Record<string, unknown>): IsolatedTradeFold {
  let fold: Promise<OfficialFold> | null = null;
  const run = async (p: IsolatedTradeInput): Promise<IsolatedTradeResult> => {
    fold ??= OfficialFold.start(python, vendorRoot, config);
    const f = await fold;
    await f.reset(config);
    await f.seed(p.ref);                                   // only sets the global price; it never decides an outcome
    await f.sweep(p.sweep - 1, p.ref, p.ref, p.owners, []);
    const res = await f.sweep(p.sweep, p.ref, p.close, [], [p.trade]);
    const t = res.trades.find((x) => x.id === p.trade.id);
    const { accounts } = await f.accounts(p.owners, p.close);
    return { outcome: t?.outcome ?? "void", reason: t ? t.reason ?? null : "not in the fold result", accounts };
  };
  return Object.assign(run, { stop: () => { void fold?.then((f) => f.stop()).catch(() => undefined); } });
}
