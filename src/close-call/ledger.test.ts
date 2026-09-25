/**
 * Differential test: the TypeScript mirror (ledger.ts) against the OFFICIAL fold (vendored
 * close_call_fold.py through the bridge). Thousands of random trades, including every edge
 * the risk engine relies on: FIFO partial closes, flips, self-trades, duplicate ids, the
 * +-5% edge, bad shapes, until/lock, funds at the limit, clawback both ways.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fmt2, fmtShort, toMicro } from "./decimal.js";
import { OfficialFold } from "./fold.js";
import { paperDid } from "./keys.js";
import { Ledger, type WireTrade } from "./ledger.js";
import { contest, VENDOR } from "./test-helpers.js";
import { foldConfig, foldParams } from "./paper.js";

let fold: OfficialFold;
before(async () => { fold = await OfficialFold.start("python3", VENDOR, foldConfig(contest())); });
after(() => fold.stop());

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test("sample season: the mirror reproduces the fold's expected output", async () => {
  const lines = readFileSync(`${VENDOR}/examples/sample-season.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const expected = JSON.parse(readFileSync(`${VENDOR}/examples/sample-season.expected.json`, "utf8"));
  const l = new Ledger(foldParams(contest()));
  const sweeps = [];
  for (const e of lines) {
    if (e.t !== "sweep") continue;
    const r = l.sweep(e.n, toMicro(e.ref), toMicro(e.close), e.owners, e.trades);
    sweeps.push(r.outcomes.map((o) => o.outcome === "settled" ? `settled ${fmtShort(o.makerFee!)} ${fmtShort(o.takerFee!)}` : `void ${o.reason}`));
  }
  const exp = expected.sweeps.map((s: { trades: { outcome: string; reason?: string; maker_fee?: string; taker_fee?: string }[] }) =>
    s.trades.map((t) => t.outcome === "settled" ? `settled ${fmtShort(toMicro(t.maker_fee!))} ${fmtShort(toMicro(t.taker_fee!))}` : `void ${t.reason}`));
  assert.deepEqual(sweeps, exp);
  const S = toMicro(expected.final.S);
  for (const row of expected.final.standings) {
    assert.equal(l.accounts.get(row.key)!.valueAt(S) - 10_000_000_000n, toMicro(row.score), row.key);
  }
});

test("random trades: identical outcomes, fees, cash and FIFO lots (fold vs mirror)", async () => {
  const r = rng(20260925);
  const keys = Array.from({ length: 8 }, (_, i) => paperDid(`DIFF${i}`));
  await fold.reset(foldConfig(contest()));
  await fold.seed("226.14");
  const l = new Ledger(foldParams(contest()));
  let ref = 226.14;
  const usedIds: string[] = [];
  let voids = 0;
  let settled = 0;
  for (let n = 1; n <= 60; n++) {
    const close = Math.max(50, ref * (1 + (r() - 0.5) * 0.04));
    const trades: WireTrade[] = [];
    for (let i = 0; i < 12; i++) {
      const maker = keys[Math.floor(r() * keys.length)];
      const signer = r() < 0.08 ? maker : keys[Math.floor(r() * keys.length)];
      const px = ref * (1 + (r() - 0.5) * 0.105);                      // straddles the +-5% edge
      const qtyPick = r();
      const qty = qtyPick < 0.05 ? "0.09" : qtyPick < 0.08 ? "1.234" : (qtyPick * 50).toFixed(2);
      const id = r() < 0.1 && usedIds.length ? usedIds[Math.floor(r() * usedIds.length)] : `id${n}x${i}`;
      usedIds.push(id);
      trades.push({ id, maker, side: r() < 0.5 ? "buy" : "sell", qty, px: px.toFixed(2), taker: r() < 0.1 ? "any" : signer,
        until: r() < 0.05 ? n - 1 : n + 3, countersigner: signer });
    }
    const owners = n === 1 ? keys : [];
    const refS = ref.toFixed(2);
    const closeS = close.toFixed(2);
    const a = await fold.sweep(n, refS, closeS, owners, trades);
    const b = l.sweep(n, toMicro(refS), toMicro(closeS), owners, trades);
    b.outcomes.forEach((o, i) => {
      const f = a.trades[i];
      assert.equal(o.outcome, f.outcome, `sweep ${n} trade ${i}`);
      assert.equal(o.reason ?? undefined, f.reason ?? undefined, `sweep ${n} trade ${i}`);
      if (o.outcome === "settled") {
        settled++;
        assert.equal(o.makerFee, toMicro(f.maker_fee!));
        assert.equal(o.takerFee, toMicro(f.taker_fee!));
      } else voids++;
    });
    ref = Number(closeS);
  }
  const fa = await fold.accounts(keys, "240.00");
  for (const k of keys) {
    const t = l.accounts.get(k)!;
    const f = fa.accounts[k];
    assert.equal(t.cash, toMicro(f.cash), `cash ${k}`);
    assert.equal(t.fees, toMicro(f.fees), `fees ${k}`);
    assert.deepEqual(t.lots.map((x) => [fmtShort(x.qty), fmt2(x.px)]), f.lots.map(([q, p]) => [fmtShort(toMicro(q)), fmt2(toMicro(p))]), `lots ${k}`);
    assert.equal(t.valueAt(toMicro("240.00")), toMicro(f.value!), `value ${k}`);
  }
  assert.ok(settled > 50 && voids > 50, `exercised both paths: settled=${settled} void=${voids}`);
});
