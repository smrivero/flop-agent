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
import { keysByRole, keyStatusCounts, listKeys, roleKeyId, type ConfirmationPolicyName, type KeyRole } from "../keys.js";
import { ownerMessageText } from "../protocol.js";
import type { Signer } from "../protocol-writes.js";
import { getRoom } from "../room.js";
import { haltSummary } from "../safety.js";
import { getMeta, now, openCloseCallDb, type CcDb } from "../store.js";
import { ephemeralSigner } from "./ephemeral-signer.js";
import { MockTechnocore } from "./mock-technocore.js";
import { SimReferee } from "./sim-referee.js";

export interface SimOptions {
  /** STRATEGY key counts to reach, in order. Stage 1 also creates CC-ADMIN + CC-TEST-001/002: [0, 100] = staging first, then 100. */
  stages: number[];
  /** Inject a 429 before these (1-based) POSTs. */
  rate429At?: number[];
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
  /** The simulated world after the bootstrap, to keep going (live trading) in the same server + DB. */
  world: { db: CcDb; srv: MockTechnocore; signers: Map<string, Signer>; referee: SimReferee; room: string; now: () => number; setNow: (ms: number) => void; publish: (n: number) => void; published: () => number };
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
  referee.seed();
  referee.baseline(o.startSweep);
  const lag = o.refereeLagMs ?? 20_000;
  const perWriteMs = 60_000 / (o.writesPerMin ?? 75);
  const steps: StepResult[] = [];
  const stages: SimReport["stages"] = [];
  let missed = false;

  const addRole = (role: KeyRole, total: number) => {
    for (let i = keysByRole(db, role).length + 1; i <= total; i++) {
      const id = roleKeyId(role, i);
      const s = ephemeralSigner();
      signers.set(id, s);
      db.prepare("INSERT INTO keys (id, did, key_path, fake, status, role, updated_at) VALUES (?, ?, NULL, 0, 'GENERATED', ?, ?)").run(id, s.did, role, now());
    }
  };
  const addKeys = (strategyTotal: number) => { addRole("admin", 1); addRole("staging", 2); addRole("strategy", strategyTotal); };
  const realPost = srv.post.bind(srv);
  srv.post = async (path, body) => { if (o.rate429At?.includes(srv.posts + 1)) srv.failNext("429"); return realPost(path, body); };
  const publishDue = async () => {
    while (sweepTime(contest, published + 1) + lag <= simNow) {
      published++;
      if (o.missFirstOwner && !missed) {
        const first = keysByRole(db, "admin")[0];
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
      refreshReferee: publishDue, gate: () => ({ ok: true, problems: [] }), pace: async () => { simNow += perWriteMs; },
      sleep: async (ms) => { simNow += ms; }, refreshDays: 5,
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
  const admin = keysByRole(db, "admin")[0];
  const nonAdmin = [...keysByRole(db, "staging"), ...keysByRole(db, "strategy")];
  const checks: SimReport["checks"] = [];
  const count = (roomName: string, text: string) => srv.count(roomName, text);
  const dupOwners = keys.filter((k) => {
    const reposts = Number(getMeta(db, `owner_reposts:${k.id}`) ?? "0");
    return count("close1", ownerMessageText(k.did)) + count(room, ownerMessageText(k.did)) > 1 + reposts;
  });
  checks.push({ name: "no duplicated owner message (beyond deliberate reposts of missed ones)", ok: dupOwners.length === 0, detail: dupOwners.map((k) => k.id).join(" ") || "-" });
  const allTexts = [...srv.rooms.values()].flat().map((m) => `${m.from}|${m.text}`);
  checks.push({ name: "0 duplicate writes (every stored message unique)", ok: new Set(allTexts).size === allTexts.length - keys.reduce((a, k) => a + Number(getMeta(db, `owner_reposts:${k.id}`) ?? "0"), 0), detail: `${allTexts.length} messages` });
  checks.push({ name: "room owned by CC-ADMIN", ok: srv.notes.get(`room-owners/${room}`) === admin?.did, detail: room });
  const allow = (srv.notes.get(`room-allow/${room}`) ?? "").split(" ").filter(Boolean);
  checks.push({ name: "allow-list = staging + strategy keys, nothing else", ok: allow.length === nonAdmin.length && nonAdmin.every((k) => allow.includes(k.did)), detail: `${allow.length} DIDs, ${(srv.notes.get(`room-allow/${room}`) ?? "").length} chars` });
  checks.push({ name: "exactly one room registration message", ok: count("close1", `{"t":"room","season":"close-1","room":"${room}"}`) === 1, detail: "" });
  checks.push({ name: "every key READY", ok: keys.every((k) => k.status === "READY"), detail: JSON.stringify(keyStatusCounts(db)) });
  const tt = getMeta(db, "test_trade_id");
  const ttRow = tt ? (db.prepare("SELECT status, maker_id, taker_id FROM trades WHERE trade_id = ?").get(tt) as { status: string; maker_id: string; taker_id: string }) : null;
  checks.push({ name: "staging trade (CC-TEST-001 -> CC-TEST-002) settled exactly once", ok: !!tt && referee.settled.has(tt) && ttRow?.status === "settled" && ttRow.maker_id === "CC-TEST-001", detail: tt ?? "none" });
  const strategyDids = new Set(keysByRole(db, "strategy").map((k) => k.did));
  const touched = [...srv.rooms.values()].flat().filter((m) => /"t":"trade"/.test(m.text) && [...strategyDids].some((d) => m.text.includes(d)));
  checks.push({ name: "strategy keys untouched by bootstrap (no trade, no fee: 10,000 POLF, flat)", ok: touched.length === 0, detail: `${strategyDids.size} strategy keys` });
  const journal = Object.fromEntries((db.prepare("SELECT state, COUNT(*) n FROM write_attempts GROUP BY state").all() as { state: string; n: number }[]).map((r) => [r.state, r.n]));
  checks.push({ name: "no write left unresolved", ok: !journal.UNKNOWN && !journal.SENDING && !journal.PLANNED && !journal.PREPARED, detail: JSON.stringify(journal) });
  return {
    ok: checks.every((c) => c.ok) && steps.at(-1)?.action === "done",
    stages, steps,
    final: { keys: keyStatusCounts(db), room: getRoom(db, room).status, halted: haltSummary(db), testTrade: ttRow?.status ?? null },
    server: { posts: srv.posts, messages: Object.fromEntries([...srv.rooms].map(([k, v]) => [k, v.length])), ownerNote: srv.notes.has(`room-owners/${room}`), allowDids: allow.length },
    checks, journal,
    world: { db, srv, signers, referee, room, now: () => simNow, setNow: (ms) => { simNow = ms; },
      publish: (n) => { referee.sweep(n, sweepTime(contest, n) + lag); published = Math.max(published, n); }, published: () => published },
  };
}
