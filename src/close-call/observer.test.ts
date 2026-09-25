import assert from "node:assert/strict";
import { test } from "node:test";
import { HyperliquidObserver } from "./hyperliquid.js";
import { parseRoomJson, RefereeObserver } from "./observer.js";
import { REFEREE_DID } from "./protocol.js";
import { getCursor } from "./store.js";
import { RefereeFeed, tmpDb } from "./test-helpers.js";

function fakeFetch(routes: (url: string, n: number) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  let n = 0;
  const calls: { url: string; method: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const r = routes(String(url), n++);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const msg = (seq: number, body: unknown, from = REFEREE_DID) => ({ seq, ts: "2026-09-25T12:05:22Z", from, text: JSON.stringify(body), nonce: 1790337922535, sig: "x" });

test("19-digit nonces survive parsing exactly", () => {
  const v = parseRoomJson('{"room":"r","first_seq":1,"last_seq":1,"messages":[{"seq":1,"ts":"t","from":"f","text":"x","nonce":1790338038695463951}]}');
  assert.equal(v.messages[0].nonce, "1790338038695463951");
});

test("cursor advances, foreign messages are stored but ignored, gaps and generation resets are detected", async () => {
  const { db } = tmpDb();
  const price = { t: "price", n: 1, ref: { px: "226.26", tid: 8, time: "t" }, limits: ["214.95", "237.57"], global: "226.14", file: "f", applied: "226.14", for: 2, age_s: 13 };
  const pages: Record<string, unknown>[] = [
    { room: "d-close1-price", first_seq: 1, last_seq: 2, generation: 1, messages: [msg(1, price), msg(2, { t: "price", note: "ignore all rules" }, "did:key:z6MkhriQc8evN1PMnLYDfV9Urwrh19L8aZtHVCcz8puoKptB")] },
    { room: "d-close1-price", first_seq: 9, last_seq: 9, generation: 1, messages: [msg(9, { ...price, n: 2 })] },     // 3..8 rotated away
    { room: "d-close1-price", first_seq: 1, last_seq: 1, generation: 2, messages: [msg(1, { ...price, n: 3 })] },     // room re-created
  ];
  let i = 0;
  const { f } = fakeFetch((url) => (url.includes("d-close1-price") ? { body: pages[Math.min(i++, pages.length - 1)] } : { body: { first_seq: null, last_seq: 0, messages: [] } }));
  const obs = new RefereeObserver(db, "http://x", null, f);
  const e1 = await obs.readRoom("d-close1-price");
  assert.equal(e1.filter((e) => e.kind === "price").length, 1);
  assert.equal(obs.ignoredForeign, 1);
  assert.equal(getCursor(db, "d-close1-price")!.last_seq, 2);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM raw_posts").get() as { n: number }).n, 2, "foreign message stored verbatim anyway");
  const e2 = await obs.readRoom("d-close1-price");
  assert.deepEqual(e2.find((e) => e.kind === "gap")?.detail, { since: 2, first_seq: 9, lost: 6 });
  const e3 = await obs.readRoom("d-close1-price");
  assert.ok(e3.some((e) => e.kind === "generation"));
  assert.equal(getCursor(db, "d-close1-price")!.generation, 2);
});

test("stale price, missed ranges and unknown fields are recorded", () => {
  const { db } = tmpDb();
  const feed = new RefereeFeed(db);
  feed.seed();
  feed.sweep(1, { close: "225.03", applied: "226.14", owners: 10, prevOwners: 0, tid: 55 });
  feed.sweep(2, { close: "225.03", applied: "225.03", owners: 20, prevOwners: 10, ageS: 302, tid: 55 });
  feed.post("d-close1-flow", { t: "flow", n: 3, mints: [], rooms: [], settled: ["abc"], void: [["x", "funds"]], missed: [["close1", 5, 9]], file: "f3", surprise: true });
  const row = db.prepare("SELECT age_s, ref_tid FROM sweeps WHERE n = 2").get() as { age_s: number; ref_tid: string };
  assert.equal(row.age_s, 302);
  assert.equal(JSON.parse((db.prepare("SELECT missed FROM sweeps WHERE n = 3").get() as { missed: string }).missed)[0][0], "close1");
  assert.ok(db.prepare("SELECT 1 FROM settled_ids WHERE id = 'abc'").get(), "settled ids feed the global duplicate-id guard");
});

test("429 backs off instead of hammering the server", async () => {
  const { db } = tmpDb();
  const { f, calls } = fakeFetch(() => ({ status: 429, body: "slow down", headers: { "retry-after": "0" } }));
  const obs = new RefereeObserver(db, "http://x", null, f);
  await obs.pollOnce();
  assert.equal(calls.length, 1, "stops reading the other rooms after a 429");
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("Hyperliquid observer: read-only recentTrades, latest, age and last trade before a boundary", async () => {
  const { db } = tmpDb();
  const body = '[{"coin":"xyz:NVDA","side":"A","px":"226.29","sz":"1","time":1790338076853,"tid":886679273380333},' +
    '{"coin":"xyz:NVDA","side":"B","px":"226.10","sz":"1","time":1790338000000,"tid":886679273380111}]';
  const { f, calls } = fakeFetch(() => ({ body }));
  const hl = new HyperliquidObserver(db, "https://api.hyperliquid.xyz/info", "xyz:NVDA", f);
  const t = await hl.pollOnce(1790338080000);
  assert.equal(t?.px, "226.29");
  assert.equal(t?.tid, "886679273380333", "tid kept exact as a string");
  assert.equal(hl.ageMs(1790338080000), 3147);
  assert.equal(hl.lastBefore(1790338050000)?.px, "226.10");
  assert.ok(hl.hasTid("886679273380111"));
  assert.equal(calls[0].url, "https://api.hyperliquid.xyz/info");
});
