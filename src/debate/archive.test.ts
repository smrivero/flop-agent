import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveRoom, isArchiveDue } from "./archive.js";
import { TechnocoreClient } from "../technocore.js";

function tempArchivePath(): string {
  return mkdtempSync(join(tmpdir(), "debate-archive-test-"));
}

test("isArchiveDue: true when never archived before", () => {
  assert.equal(isArchiveDue(null, 24), true);
});

test("isArchiveDue: false when well within the interval", () => {
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
  assert.equal(isArchiveDue(oneHourAgo, 24), false);
});

test("isArchiveDue: true once the interval has elapsed", () => {
  const twoDaysAgo = new Date(Date.now() - 48 * 3600_000).toISOString();
  assert.equal(isArchiveDue(twoDaysAgo, 24), true);
});

test("isArchiveDue: a corrupt timestamp is treated as due, not as a crash", () => {
  assert.equal(isArchiveDue("not-a-date", 24), true);
});

/** A fake fetch that answers GET /r/<room>/export with fixed NDJSON and a
 * generation header -- exercises the real client method against real,
 * documented response shape, no real network. */
function fakeExportFetch(ndjson: string, generation = 3): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/export")) {
      return new Response(ndjson, { status: 200, headers: { "X-Room-Generation": String(generation), "Content-Type": "application/x-ndjson" } });
    }
    return new Response("404 no route matched", { status: 404 });
  }) as typeof fetch;
}

test("archiveRoom: writes data/archive/<room>/<date>.jsonl with byte-exact export content", async () => {
  const archivePath = tempArchivePath();
  const ndjson = '{"seq":1,"ts":"2026-09-01T00:00:00Z","from":"did:key:z6MkTest","text":"hi","nonce":1,"sig":"x"}\n';
  const client = new TechnocoreClient({ fetchImpl: fakeExportFetch(ndjson) });

  const now = new Date("2026-09-01T12:00:00Z");
  const result = await archiveRoom(client, archivePath, "d-elclasico", now);

  assert.equal(result.path, join(archivePath, "d-elclasico", "2026-09-01.jsonl"));
  assert.ok(existsSync(result.path));
  assert.equal(readFileSync(result.path, "utf8"), ndjson);
  assert.equal(result.generation, 3);
});

test("archiveRoom: writes a matching sha256 sidecar file, sha256sum-compatible format", async () => {
  const archivePath = tempArchivePath();
  const ndjson = '{"seq":1,"text":"hello world"}\n';
  const client = new TechnocoreClient({ fetchImpl: fakeExportFetch(ndjson) });
  const now = new Date("2026-09-01T12:00:00Z");

  const result = await archiveRoom(client, archivePath, "d-elclasico", now);

  const expectedHash = createHash("sha256").update(ndjson, "utf8").digest("hex");
  assert.equal(result.sha256, expectedHash);

  const sidecar = readFileSync(result.hashPath, "utf8");
  assert.equal(sidecar, `${expectedHash}  2026-09-01.jsonl\n`);
});

test("archiveRoom: re-running on the same UTC day overwrites that day's file rather than accumulating duplicates", async () => {
  const archivePath = tempArchivePath();
  const client1 = new TechnocoreClient({ fetchImpl: fakeExportFetch("first export\n") });
  const now = new Date("2026-09-01T08:00:00Z");
  const first = await archiveRoom(client1, archivePath, "d-elclasico", now);
  assert.equal(readFileSync(first.path, "utf8"), "first export\n");

  const client2 = new TechnocoreClient({ fetchImpl: fakeExportFetch("second export, later same day\n") });
  const later = new Date("2026-09-01T20:00:00Z");
  const second = await archiveRoom(client2, archivePath, "d-elclasico", later);

  assert.equal(second.path, first.path);
  assert.equal(readFileSync(second.path, "utf8"), "second export, later same day\n");
});
