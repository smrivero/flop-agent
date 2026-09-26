/**
 * `bootstrap --dry-run`: the real Bootstrap state machine, the real write journal and the real
 * signing code, against an in-memory technocore (MockTechnocore) and a simulated referee, with
 * throwaway in-memory keys and a temporary database. No network, no key file, no real write.
 *
 * Every step() uses a fresh Bootstrap + WriteJournal over the same database, i.e. every step is a
 * process restart. With `faults`, the mock also loses requests and times out after committing,
 * and one write is left planned-but-unsent, as if the process had died there.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bootstrap, type StepResult } from "../bootstrap.js";
import { sweepTime, type Contest } from "../contest.js";
import { WriteJournal } from "../journal.js";
import { keyId, keyStatusCounts, listKeys, type ConfirmationPolicyName } from "../keys.js";
import { ownerMessageText } from "../protocol.js";
import type { Signer } from "../protocol-writes.js";
import { getRoom } from "../room.js";
import { haltSummary } from "../safety.js";
import { getMeta, now, openCloseCallDb, type CcDb } from "../store.js";
import { ephemeralSigner } from "./ephemeral-signer.js";
import { MockTechnocore } from "./mock-technocore.js";
import { SimReferee } from "./sim-referee.js";

export interface SimOptions {
  /** Key counts to reach, in order: [2, 100] = the progressive plan. */
  stages: number[];
  policy?: ConfirmationPolicyName;
  room?: string;
  listMints?: boolean;
  faults?: boolean;
  startSweep: number;
  refereeLagMs?: number;
  writesPerMin?: number;
  maxSteps?: number;
  /** The referee "misses" CC001's first owner message in close1 (as it missed thousands live). */
  missFirstOwner?: boolean;
  db?: CcDb;
}

export interface SimReport {
  ok: boolean;
  stages: { keys: number; steps: number; sweeps: number; minutes: number; writes: number }[];
  steps: StepResult[];
  final: { keys: Record<string, number>; room: string; halted: string | null; testTrade: string | null };
  server: { posts: number; messages: Record<string, number>; ownerNote: boolean; allowDids: number };
  checks: { name: string; ok: boolean; detail: string }[];
  journal: Record<string, number>;
}

export async function simulateBootstrap(contest: Contest, o: SimOptions): Promise<SimReport> {
  const db = o.db ?? openCloseCallDb(join(mkdtempSync(join(tmpdir(), "closecall-dryrun-")), "live.sqlite3"));
  const room = o.room ?? "d-cc-dryrun";
  let simNow = sweepTime(contest, o.startSweep) + 30_000;
  const srv = new MockTechnocore();
  srv.clock = () => simNow;
  const signers = new Map<string, Signer>();
  const referee = new SimReferee(db, srv, contest, { listMints: o.listMints ?? false });
  let published = o.startSweep;
  const lag = o.refereeLagMs ?? 20_000;
  const perWriteMs = 60_000 / (o.writesPerMin ?? 75);
  const steps: StepResult[] = [];
  const stages: SimReport["stages"] = [];
  let missed = false;

  const addKeys = (total: number) => {
    const have = listKeys(db).length;
    for (let i = have + 1; i <= total; i++) {
      const id = keyId(i);
      const s = ephemeralSigner();
      signers.set(id, s);
      db.prepare("INSERT INTO keys (id, did, key_path, fake, status, updated_at) VALUES (?, ?, NULL, 0, 'GENERATED', ?)").run(id, s.did, now());
    }
  };
  const publishDue = async () => {
    while (sweepTime(contest, published + 1) + lag <= simNow) {
      published++;
      if (o.missFirstOwner && !missed) {
        const first = listKeys(db)[0];
        const msg = (srv.rooms.get("close1") ?? []).find((m) => m.text === ownerMessageText(first.did));
        if (msg) {
          (referee as unknown as { opts: { missSeqs?: { room: string; from: number; to: number }[] } }).opts.missSeqs = [{ room: "close1", from: msg.seq, to: msg.seq }];
          missed = true;
        }
      }
      referee.sweep(published, sweepTime(contest, published) + lag);
      (referee as unknown as { opts: { missSeqs?: unknown } }).opts.missSeqs = undefined;
    }
  };
  const deps = () => {
    const journal = new WriteJournal(db, signers, srv, { clock: () => simNow });
    return new Bootstrap({
      db, contest, journal, transport: srv, signers, policy: o.policy ?? "PROTOCOL", room, clock: () => simNow,
      refreshReferee: publishDue, gate: () => ({ ok: true, problems: [] }), pace: async () => { simNow += perWriteMs; }, refreshDays: 5,
    });
  };

  if (o.faults) srv.failNext("timeout-after-commit");            // the claim: stored, but the client times out
  let faultedOwners = false;
  let crashedPlan = false;
  for (const target of o.stages) {
    addKeys(target);
    const t0 = simNow;
    const posts0 = srv.posts;
    let n = 0;
    for (; n < (o.maxSteps ?? 400); n++) {
      if (o.faults && !faultedOwners && getRoom(db, room).status === "READY" && listKeys(db).some((k) => k.status === "GENERATED")) {
        srv.failNext("drop");
        srv.failNext("timeout-after-commit");
        faultedOwners = true;
      }
      if (o.faults && !crashedPlan && faultedOwners) {
        const k = listKeys(db).find((x) => x.status === "GENERATED");
        if (k) {                                                   // the process dies right after planning this write
          new WriteJournal(db, signers, srv, { clock: () => simNow }).plan({ opKey: `owner:${k.id}`, kind: "owner", signerId: k.id, room, text: ownerMessageText(k.did) });
          crashedPlan = true;
        }
      }
      const r = await deps().step();
      steps.push(r);
      if (r.action === "done" || r.action === "blocked" || r.action === "halted") break;
      if (r.action === "waiting") simNow = Math.max(simNow, sweepTime(contest, published + 1) + lag) + 1;
    }
    stages.push({ keys: target, steps: n + 1, sweeps: published - o.startSweep, minutes: Math.round((simNow - t0) / 60_000), writes: srv.posts - posts0 });
    if (steps.at(-1)?.action !== "done") break;
  }

  const keys = listKeys(db);
  const checks: SimReport["checks"] = [];
  const count = (roomName: string, text: string) => srv.count(roomName, text);
  const dupOwners = keys.filter((k) => {
    const reposts = Number(getMeta(db, `owner_reposts:${k.id}`) ?? "0");
    return count("close1", ownerMessageText(k.did)) + count(room, ownerMessageText(k.did)) > 1 + reposts;
  });
  checks.push({ name: "no duplicated owner message (beyond deliberate reposts of missed ones)", ok: dupOwners.length === 0, detail: dupOwners.map((k) => k.id).join(" ") || "-" });
  checks.push({ name: "room owned by CC001", ok: srv.notes.get(`room-owners/${room}`) === keys[0]?.did, detail: room });
  const allow = (srv.notes.get(`room-allow/${room}`) ?? "").split(" ").filter(Boolean);
  checks.push({ name: "allow-list = every other key, nothing else", ok: allow.length === keys.length - 1 && keys.slice(1).every((k) => allow.includes(k.did)), detail: `${allow.length} DIDs` });
  checks.push({ name: "exactly one room registration message", ok: count("close1", `{"t":"room","season":"close-1","room":"${room}"}`) === 1, detail: "" });
  checks.push({ name: "every key READY", ok: keys.every((k) => k.status === "READY"), detail: JSON.stringify(keyStatusCounts(db)) });
  const tt = getMeta(db, "test_trade_id");
  const ttRow = tt ? (db.prepare("SELECT status FROM trades WHERE trade_id = ?").get(tt) as { status: string }) : null;
  checks.push({ name: "test trade settled exactly once", ok: !!tt && referee.settled.has(tt) && ttRow?.status === "settled", detail: tt ?? "none" });
  const journal = Object.fromEntries((db.prepare("SELECT state, COUNT(*) n FROM write_attempts GROUP BY state").all() as { state: string; n: number }[]).map((r) => [r.state, r.n]));
  checks.push({ name: "no write left unresolved", ok: !journal.UNKNOWN && !journal.SENDING && !journal.PLANNED && !journal.PREPARED, detail: JSON.stringify(journal) });
  return {
    ok: checks.every((c) => c.ok) && steps.at(-1)?.action === "done",
    stages, steps,
    final: { keys: keyStatusCounts(db), room: getRoom(db, room).status, halted: haltSummary(db), testTrade: ttRow?.status ?? null },
    server: { posts: srv.posts, messages: Object.fromEntries([...srv.rooms].map(([k, v]) => [k, v.length])), ownerNote: srv.notes.has(`room-owners/${room}`), allowDids: allow.length },
    checks, journal,
  };
}
