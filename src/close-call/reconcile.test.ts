import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSweep, reconcileReferee } from "./reconcile.js";
import { haltSummary } from "./safety.js";
import { RefereeFeed, tmpDb } from "./test-helpers.js";

function season() {
  const { db } = tmpDb();
  const feed = new RefereeFeed(db);
  feed.seed("226.14");
  feed.sweep(1, { close: "226.26", applied: "226.14", owners: 0, prevOwners: 0 });
  feed.sweep(2, { close: "225.80", applied: "226.26", owners: 370, prevOwners: 0 });
  feed.sweep(3, { close: "225.80", applied: "225.80", owners: 405, prevOwners: 370, ageS: 300 });
  return { db, feed };
}

test("L1: a consistent referee history reconciles OK", () => {
  const { db } = season();
  const out = reconcileReferee(db);
  assert.deepEqual(out.map((r) => r.status), ["OK", "OK", "OK"]);
  assert.equal(haltSummary(db), null);
});

test("L1: inconsistent owners, applied or file hashes are a MISMATCH and halt the strategy", () => {
  const { db } = season();
  db.prepare("UPDATE sweeps SET owners = 999 WHERE n = 3").run();
  const out = reconcileReferee(db);
  assert.equal(out.at(-1)!.status, "MISMATCH");
  assert.match(out.at(-1)!.failed.join(), /owners/);
  assert.match(haltSummary(db)!, /L1 referee mismatch at sweep 3/);

  const b = season().db;
  b.prepare("UPDATE sweeps SET applied = '226.00' WHERE n = 2").run();
  assert.match(checkSweep(b, 2).failed.join(), /applied/);
  b.prepare(`UPDATE sweeps SET pnl_json = json_set(pnl_json, '$.file', 'other') WHERE n = 1`).run();
  assert.match(checkSweep(b, 1).failed.join(), /file/);
});

test("L1: a sweep whose five posts have not all arrived is INCOMPLETE, never OK", () => {
  const { db, feed } = season();
  feed.post("d-close1-price", { t: "price", n: 4, ref: { px: "225.00", tid: 1, time: "t" }, limits: ["213.75", "236.25"], global: "225.80", file: "f4", applied: "225.80", for: 5, age_s: 1 });
  assert.equal(checkSweep(db, 4).status, "INCOMPLETE");
  const out = reconcileReferee(db);
  assert.ok(!out.some((r) => r.n === 4 && r.status === "OK"));
});
