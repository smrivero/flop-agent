/**
 * Safety guard for this build. If any assertion fails, a write/signing path reached code it must not.
 *
 *  - Signing, key material and POSTs to technocore exist ONLY in src/close-call/live/.
 *  - No runtime file outside live/ imports live/ (statically or dynamically), and none imports testing/.
 *  - The only other non-GET requests: Hyperliquid's read-only recentTrades, and the optional alert
 *    webhook/Telegram sinks (which refuse technocore URLs).
 *  - Live mode needs two deliberate settings, and this build refuses it anyway.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { CloseCallConfigError, LIVE_ACK, loadCloseCallConfig } from "./config.js";
import { loadRealKey, RealKeysNotAvailable, wouldSign } from "./keys.js";

const DIR = join(process.cwd(), "src/close-call");

function sources(dir = DIR): { path: string; rel: string; text: string }[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    if (!/\.(ts|py)$/.test(f) || f.endsWith(".test.ts") || f === "test-helpers.ts") return [];
    return [{ path: p, rel: relative(DIR, p), text: readFileSync(p, "utf8") }];
  });
}
const runtime = () => sources().filter((s) => !s.rel.startsWith("live/") && !s.rel.startsWith("testing/"));
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\*.*$/gm, "");

test("signing and key material exist only in live/", () => {
  const forbidden = [/say-signed/, /set-signed\//, /\/say\//, /sendSigned/, /writeNote/, /setSignedNote/, /loadIdentity/, /seedHex/,
    /createPrivateKey/, /import\s*\{[^}]*\bsign\b[^}]*\}\s*from\s*"node:crypto"/, /from "\.\.\/identity/, /from "\.\.\/technocore/];
  for (const { rel, text } of runtime()) for (const re of forbidden) assert.ok(!re.test(code(text)), `${rel} matches ${re}`);
});

test("no runtime file imports live/ or testing/", () => {
  for (const { rel, text } of runtime()) {
    assert.ok(!/["'`]\.{1,2}\/(live|testing)\//.test(text), `${rel} references live/ or testing/`);
    assert.ok(!/import\(\s*[^)]*live/.test(text), `${rel} dynamically imports live code`);
  }
});

test("the only non-GET requests outside live/: Hyperliquid recentTrades and the alert sinks", () => {
  for (const { rel, text } of runtime()) {
    const posts = (code(text).match(/method:\s*"(POST|PUT|DELETE|PATCH)"/g) ?? []).length;
    if (rel === "hyperliquid.ts") {
      assert.equal(posts, 1);
      assert.match(text, /type: "recentTrades"/);
      assert.ok(!/\/exchange|\baction\s*:|signature|wallet|privateKey/i.test(code(text)), "no exchange/order code");
    } else if (rel === "readiness.ts") {
      // Hyperliquid's read-only info query (latency + feed health); never technocore.
      assert.ok(posts <= 2, `${rel}: ${posts} non-GET`);
      assert.ok((code(text).match(/method:\s*"POST"[\s\S]{0,160}?recentTrades/g) ?? []).length === posts, "only recentTrades");
      assert.ok(!/technocoreBaseUrl[^\n]*method:\s*"POST"/.test(code(text)), "never a POST to technocore");
    } else if (rel === "alerts.ts") {
      assert.equal(posts, 2);
      assert.match(text, /must not point at technocore\.chat/);
    } else {
      assert.equal(posts, 0, `${rel} makes a non-GET request`);
    }
  }
});

test("live mode needs both deliberate settings; anything else refuses to start (NO WRITE)", () => {
  assert.throws(() => loadCloseCallConfig({ CLOSECALL_MODE: "live" }), CloseCallConfigError);
  assert.throws(() => loadCloseCallConfig({ CLOSECALL_MODE: "live", CLOSECALL_LIVE_ENABLED: "true" }), CloseCallConfigError);
  assert.throws(() => loadCloseCallConfig({ CLOSECALL_MODE: "production" }), CloseCallConfigError);
  assert.throws(() => loadCloseCallConfig({ CLOSECALL_MODE: "paper", CLOSECALL_LIVE_ENABLED: LIVE_ACK }), CloseCallConfigError);
  assert.equal(loadCloseCallConfig({}).mode, "paper", "paper is the default");
  assert.equal(loadCloseCallConfig({ CLOSECALL_MODE: "live", CLOSECALL_LIVE_ENABLED: LIVE_ACK }).mode, "live", "config accepts it ...");
  const cli = readFileSync(join(DIR, "cli.ts"), "utf8");
  assert.match(cli, /live execution is not connected in this build/, "... but the PAPER CLI refuses to run it (live runs only via live\/cli-live.ts)");
  assert.throws(() => loadRealKey("/any/path.json"), RealKeysNotAvailable);
  assert.equal(wouldSign("did:key:x", "close-1|terms|{}").signature, null);
});

test("health server binds to loopback by default", () => {
  assert.equal(loadCloseCallConfig({}).health.host, "127.0.0.1");
  assert.throws(() => loadCloseCallConfig({ CLOSECALL_HEALTH_HOST: "0.0.0.0" }), CloseCallConfigError);
});

test("the CLI exposes no register, room or trade command", () => {
  const cli = readFileSync(join(DIR, "cli.ts"), "utf8");
  const m = cli.match(/COMMANDS = \[([^\]]*)\]/)!;
  const cmds = JSON.parse(`[${m[1]}]`) as string[];
  for (const c of cmds) assert.ok(!/register|trade|claim|allow|send|post/.test(c), c);
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const [k, v] of Object.entries(pkg.scripts).filter(([k]) => k.startsWith("closecall:"))) {
    assert.ok(!/register|trade|claim|LIVE_ENABLED|MODE=live/.test(k + v), `${k}: ${v}`);
  }
});

test("the live writer is connected in code and armed ONLY by configuration; paper can never arm it", () => {
  assert.equal(loadCloseCallConfig({}).liveWriter, "disarmed", "default: disarmed");
  assert.throws(() => loadCloseCallConfig({ CLOSECALL_LIVE_WRITER: "armed" }), CloseCallConfigError, "armed needs CLOSECALL_MODE=live");
  const armed = loadCloseCallConfig({ CLOSECALL_MODE: "live", CLOSECALL_LIVE_ENABLED: LIVE_ACK, CLOSECALL_LIVE_WRITER: "armed" });
  assert.equal(armed.liveWriter, "armed");
  const live = readFileSync(join(DIR, "live/cli-live.ts"), "utf8");
  assert.ok(!/LIVE_WRITER_CONNECTED/.test(live), "no code constant gates the writer: test build == production build");
  assert.match(live, /if \(!w\.armed\) \{[\s\S]{0,200}NO WRITE[\s\S]{0,80}return 3;/, "bootstrap refuses while disarmed");
  assert.match(readFileSync(join(DIR, "journal.ts"), "utf8"), /canWrite\?\.\(\)[\s\S]{0,80}throw new WriterDisarmed/, "every send passes the arming check");
  for (const { rel, text } of runtime()) {
    assert.ok(!/HttpTransport|loadSigners|generateKeys|loadFileSigner/.test(code(text)), `${rel} reaches live-only code`);
  }
});

test("paper mode cannot reach a signer: the paper CLI and service never import live/, keygen, or a key file", () => {
  for (const f of ["cli.ts", "run.ts", "paper.ts", "bootstrap.ts"]) {
    const t = readFileSync(join(DIR, f), "utf8");
    assert.ok(!/from "\.\/live\//.test(t) && !/testing\//.test(t), `${f} imports live/ or testing/`);
  }
});

test("live bootstrap and live service share ONE lock (never both writing the live state)", () => {
  const live = readFileSync(join(DIR, "live/cli-live.ts"), "utf8");
  const locks = [...live.matchAll(/acquireLock\(([^,]+),/g)].map((m) => m[1].trim());
  assert.ok(locks.length >= 2 && locks.every((l) => l === "cfg.lockPath"), JSON.stringify(locks));
});

test("secrets: no seed, private key or age secret can reach a log, an error, a URL or the DB", async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { verifyRestoredKeyDir } = await import("./live/keygen.js");
  const { loadFileSigner } = await import("./live/signer.js");
  const { didFromPublicKey } = await import("../identity.js");
  const secret = "ab".repeat(32);
  const dir = mkdtempSync(join(tmpdir(), "cc-secret-"));
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "CC001.json"), `{"did":"x","seedHex":"${secret}"`, { mode: 0o600 });          // malformed on purpose
  const r = verifyRestoredKeyDir(dir);
  assert.ok(!JSON.stringify(r).includes(secret.slice(0, 16)), "restore report never quotes the file");
  try { loadFileSigner(join(dir, "CC001.json"), didFromPublicKey); } catch (e) { assert.ok(!String((e as Error).message).includes(secret.slice(0, 16))); }
  // live writes go through POST bodies (signature in the body), never signed GET URLs
  for (const f of ["live/http-transport.ts", "protocol-writes.ts", "journal.ts", "live/executor.ts", "bootstrap.ts"]) {
    assert.ok(!/say-signed|set-signed/.test(code(readFileSync(join(DIR, f), "utf8"))), `${f} builds a signed URL`);
  }
  // the DB schema has no column for key material
  const store = readFileSync(join(DIR, "store.ts"), "utf8");
  assert.ok(!/seed_?hex|private_?key|secret/i.test(code(store).replace(/CREATE TABLE IF NOT EXISTS seed/g, "")), "no key material column");
  // logs redact secret-looking fields
  const { SECRET_FIELD } = await import("./logger.js");
  for (const k of ["seedHex", "privateKey", "age_secret", "telegramBotToken", "authorization"]) assert.ok(SECRET_FIELD.test(k), k);
});
