import assert from "node:assert/strict";
import { test } from "node:test";
import { assessMint, protocolEvidence } from "./confirmation.js";
import { sweepTime } from "./contest.js";
import { ensurePaperKeys, keyId, paperDid, transitionKey, IllegalTransition, getKey } from "./keys.js";
import { ownerMessageText } from "./protocol.js";
import { contest, RefereeFeed, tmpDb } from "./test-helpers.js";

const C = contest();
const DID = paperDid("CONF");
const at = (n: number, s = 30) => new Date(sweepTime(C, n) - 300_000 + s * 1000).toISOString();   // inside sweep n's window

function world() {
  const { db } = tmpDb();
  const feed = new RefereeFeed(db);
  feed.seed();
  for (let n = 1; n <= 6; n++) feed.sweep(n, { close: "226.00", applied: "226.00", owners: n * 10, prevOwners: (n - 1) * 10 });
  return { db, feed };
}
const flow = (feed: RefereeFeed, n: number, extra: Record<string, unknown>) =>
  feed.post("d-close1-flow", { t: "flow", n, mints: [], rooms: [], settled: [], void: [], missed: [], file: `x${n}`, ...extra });

test("STRICT: only an explicit flow.mints listing confirms; timing and protocol never do", () => {
  const { db, feed } = world();
  const msg = { did: DID, room: "close1", seq: 1234, ts: at(3), text: ownerMessageText(DID) };
  let a = assessMint(db, C, { did: DID, policy: "STRICT", ownerMessage: msg });
  assert.equal(a.confirmed, null);
  assert.equal(a.expected?.source, "protocol", "MINT_EXPECTED information is still produced");
  flow(feed, 7, { mints: [DID] });
  a = assessMint(db, C, { did: DID, policy: "STRICT", ownerMessage: msg });
  assert.equal(a.confirmed?.source, "flow.mints");
});

test("PROTOCOL: registration in a registered room, published sweep, not missed, no contrary evidence", () => {
  const { db, feed } = world();
  const ok = { did: DID, room: "close1", seq: 1234, ts: at(3), text: ownerMessageText(DID) };
  assert.equal(assessMint(db, C, { did: DID, policy: "PROTOCOL", ownerMessage: ok }).confirmed?.source, "protocol");
  assert.match(protocolEvidence(db, C, { ...ok, ts: at(9) }).blockers.join(), /not published sweep 9/);
  assert.match(protocolEvidence(db, C, { ...ok, text: ok.text + " " }).blockers.join(), /exact registration shape/);
  flow(feed, 7, { missed: [["close1", 1000, 2000]] });
  assert.match(protocolEvidence(db, C, ok).blockers.join(), /inside a range the referee missed/);
  const { db: db2, feed: f2 } = world();
  assert.match(protocolEvidence(db2, C, { ...ok, room: "d-cc-x", ts: at(3) }).blockers.join(), /not registered/);
  flow(f2, 7, { rooms: ["d-cc-x"] });
  assert.match(protocolEvidence(db2, C, { ...ok, room: "d-cc-x", ts: at(5) }).blockers.join(), /counts only after sweep 7/);
  assert.deepEqual(protocolEvidence(db2, C, { ...ok, room: "d-cc-x", ts: new Date(sweepTime(C, 8) - 60_000).toISOString() }).blockers
    .filter((b) => !/not published/.test(b)), [], "stamped after the listing sweep: accepted once that sweep is published");
  db2.prepare("INSERT INTO void_ids (id, n, reason) VALUES ('t1', 6, 'not_owner')").run();
  assert.match(protocolEvidence(db2, C, ok, ["t1"]).blockers.join(), /voided not_owner/);
});

test("PROBE: a listed settlement confirms, unless the probe id was published unsettled before (case D)", () => {
  const { db } = world();
  db.prepare("INSERT INTO settled_ids (id, n) VALUES ('p1', 5)").run();
  assert.equal(assessMint(db, C, { did: DID, policy: "PROBE", probeIds: ["p1"] }).confirmed?.source, "probe");
  const d = assessMint(db, C, { did: DID, policy: "PROBE", probeIds: ["p1"], probeExposedUnsettled: new Set(["p1"]) });
  assert.equal(d.confirmed, null);
  assert.match(d.blockers.join(), /could be a copy/);
  assert.equal(assessMint(db, C, { did: DID, policy: "STRICT", probeIds: ["p1"] }).confirmed, null, "STRICT ignores probes");
});

/**
 * Case 3 (CC001 registers our room): model of the referee's rule, checked against every case observed
 * live on 25 Sep (sweeps 60-67, research/close-call/results/live/room_registration_evidence.txt):
 * listed in flow.rooms  <=>  the signer was an owner by the sweep the room message was stamped in.
 */
test("room acceptance model: listed iff the registrant was an owner by that sweep (16 observed cases)", () => {
  type Obs = { stamp: number; ownerSweep: number | "later"; listed: boolean };
  const observed: Obs[] = [
    ...Array.from({ length: 13 }, () => ({ stamp: 62, ownerSweep: "later" as const, listed: false })),   // d-xray, d-jade, d-ember x2 ... owner registered later
    { stamp: 62, ownerSweep: 62, listed: true },            // kaifu-close1-...: owner registered in the SAME sweep
    { stamp: 63, ownerSweep: 61, listed: true },            // mabolla-task-relay
    { stamp: 62, ownerSweep: 62, listed: true },            // kaifu second copy, same sweep
  ];
  const rule = (o: Obs) => o.ownerSweep !== "later" && o.ownerSweep <= o.stamp;
  for (const o of observed) assert.equal(rule(o), o.listed);
  // So for us: CC001's owner message and our room message may even share a sweep, and our room being
  // listed is evidence CC001 was an owner (minted). Accepted by PROTOCOL and PROBE, never by STRICT.
  const { db, feed } = world();
  flow(feed, 7, { rooms: ["d-cc-ours"] });
  assert.equal(assessMint(db, C, { did: DID, policy: "PROTOCOL", registeredRoom: "d-cc-ours" }).confirmed?.source, "room-acceptance");
  assert.equal(assessMint(db, C, { did: DID, policy: "STRICT", registeredRoom: "d-cc-ours" }).confirmed, null);
});

test("state machine: MINT_EXPECTED and PROBE_PENDING never allow trading; the policy gates MINT_CONFIRMED", () => {
  const { db } = tmpDb();
  ensurePaperKeys(db, 4);
  const id = keyId(1);
  db.prepare("UPDATE keys SET fake = 0 WHERE id = ?").run(id);          // pretend real for policy checks
  transitionKey(db, id, "REGISTER_PENDING");
  assert.throws(() => transitionKey(db, id, "MINT_EXPECTED"), /needs the protocol evidence/);
  const prot = { source: "protocol" as const, sweep: 3, detail: "d" };
  transitionKey(db, id, "MINT_EXPECTED", { evidence: prot });
  assert.throws(() => transitionKey(db, id, "READY"), IllegalTransition);
  assert.throws(() => transitionKey(db, id, "MINT_CONFIRMED", { evidence: prot, policy: "STRICT" }), /STRICT does not accept protocol/);
  transitionKey(db, id, "PROBE_PENDING");
  assert.throws(() => transitionKey(db, id, "MINT_CONFIRMED", { evidence: { source: "probe", sweep: 5, detail: "p" }, policy: "PROTOCOL" }), /PROTOCOL does not accept probe/);
  transitionKey(db, id, "MINT_CONFIRMED", { evidence: { source: "probe", sweep: 5, detail: "p" }, policy: "PROBE" });
  assert.equal(getKey(db, id).status, "MINT_CONFIRMED");
  const id2 = keyId(2);
  db.prepare("UPDATE keys SET fake = 0 WHERE id = ?").run(id2);
  transitionKey(db, id2, "REGISTER_PENDING");
  transitionKey(db, id2, "PROBE_PENDING");
  transitionKey(db, id2, "REGISTER_PENDING", { reason: "probe voided not_owner" });
  transitionKey(db, id2, "MINT_CONFIRMED", { evidence: { source: "flow.mints", sweep: 9, detail: "listed" }, policy: "STRICT" });
});
