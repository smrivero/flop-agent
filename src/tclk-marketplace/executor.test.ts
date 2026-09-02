import { test } from "node:test";
import assert from "node:assert/strict";
import { executeJob, UnsupportedJobError } from "./executor.js";

test("executor: runs a whitelisted echo job", () => {
  const result = executeJob({ proto: "echo", id: "job-1", contractId: "0xabc" }, ["echo"]);
  assert.equal(result.ok, true);
  assert.match(result.summary, /job-1/);
});

test("executor: rejects a job type not in the whitelist", () => {
  assert.throws(() => executeJob({ proto: "run-shell-command", id: "job-1", contractId: "0xabc" }, ["echo"]), UnsupportedJobError);
});

test("executor: never interprets job.id/context as code -- arbitrary strings pass through inert", () => {
  const hostile = "; rm -rf / #";
  const result = executeJob({ proto: "echo", id: hostile, contractId: "0xabc" }, ["echo"]);
  assert.equal(result.ok, true);
  assert.ok(result.summary.includes(hostile)); // echoed as data, never executed
});

test("executor: stub job types (research-test / verification-test) complete without performing external work", () => {
  const r1 = executeJob({ proto: "research-test", id: "j1", contractId: "0xabc" }, ["research-test"]);
  const r2 = executeJob({ proto: "verification-test", id: "j2", contractId: "0xabc" }, ["verification-test"]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
});
