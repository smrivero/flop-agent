"""Stale-referee policy study: TRADE vs REDUCE vs HALT_NEW_ENTRIES, settled by the OFFICIAL fold.

    python3 scripts/stale_policy.py --paths 60 --workers 8     # writes results/stale_policy.csv + stale_policy_summary.json

Model (calibrated on 25 Sep): the referee's close c[n] follows Hyperliquid h[n] except in stale episodes,
where it repeats the last trade it read (age_s grows by 300 per sweep) until it recovers and jumps to h[n].
Per simulated day: one long episode (12-36 sweeps, like 13:50-16:15 UTC) and three 1-2 sweep blips.

Strategy K (split start, contrarian favoured pricing), triggers on the MARKET (h, what we watch live);
price and size from our estimate of the close:
  estimate = c[n-1] when the last post was stale (the referee keeps reusing its trade), else h[n] with
  10 s noise (sigma 0.02%).
Policies while the last referee post is stale (age_s >= 300):
  TRADE            normal margins (0.1% price / 0.3% qty)
  REDUCE           wide margins (0.4% / 1.2%) -- the behaviour paper mode had on 25 Sep
  HALT_NEW_ENTRIES no new pair (the ladder level is not consumed); triggers resume on fresh data
Scores, voids and fees come from close_call_fold.Fold with ref = c[n-1], close = c[n], S = h[final].
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import time
from decimal import Decimal as D
from multiprocessing import Pool
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import closecall as cc  # noqa: E402
from paths import make_path  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "results"
DAY = 288
POLICIES = ("TRADE", "REDUCE", "HALT_NEW_ENTRIES")


def stale_mask(rng, k=cc.FINAL_K):
    stale = np.zeros(k + 1, dtype=bool)
    for day in range(0, k, DAY):
        start = day + int(rng.integers(0, max(1, DAY - 40)))
        stale[start:start + int(rng.integers(12, 37))] = True
        for _ in range(3):
            b = day + int(rng.integers(0, DAY))
            stale[b:b + int(rng.integers(1, 3))] = True
    stale[:2] = False
    stale[cc.LOCK:] = False
    return stale


def referee_closes(h, stale):
    c = h.copy()
    for n in range(1, len(h)):
        if stale[n]:
            c[n] = c[n - 1]
    return c


def run(h, c, stale, policy, n_keys, seed, x):
    rng = np.random.default_rng(seed)
    fold = cc.new_fold()
    keys = [cc.fake_did(i, "stale") for i in range(n_keys)]
    P = [D(f"{v:.2f}") for v in c]
    H = [D(f"{v:.2f}") for v in h]
    fold.seed(str(P[0]))
    cc.run_sweep(fold, 1, P[0], P[1], keys, [])
    pairs = [(keys[i], keys[i + 1]) for i in range(0, n_keys - 1, 2)]
    nxt, lo, hi = 0, None, None
    stats = dict(settled=0, void=0, skipped=0, stale_entries=0)
    queue = []
    noise = rng.standard_t(3, cc.LOCK + 1) / math.sqrt(3) * 0.0002
    for n in range(2, cc.LOCK + 1):
        prev_stale = bool(stale[n - 1])
        est = P[n - 1] if prev_stale else D(f"{float(H[n]) * (1 + noise[n]):.2f}")
        market = float(H[n])
        orders = list(queue)
        queue = []
        want = []
        if lo is None:
            lo = hi = market
            want = ["long", "short"]
        elif market <= lo * (1 - x):
            want = ["long"]
        elif market >= hi * (1 + x):
            want = ["short"]
        if want and prev_stale and policy == "HALT_NEW_ENTRIES":
            stats["skipped"] += len(want)
            want = []
        elif want:
            if market <= lo * (1 - x):
                lo = market
            if market >= hi * (1 + x):
                hi = market
        for fav in want:
            if nxt < len(pairs):
                orders.append((pairs[nxt], fav, 0))
                nxt += 1
        if prev_stale and policy == "HALT_NEW_ENTRIES":
            queue, orders = orders, []                      # retries wait for fresh data too
        if not orders:
            continue
        wide = prev_stale and policy == "REDUCE"
        pm, qm = (D("0.004"), D("0.012")) if wide else (D("0.001"), D("0.003"))
        trades, meta = [], []
        for (a, b), fav, tries in orders:
            px = cc.price_for("favor_long" if fav == "long" else "favor_short", est, P[n - 1], pm)
            q = cc.max_qty(fold, fold.accounts[a], fold.accounts[b], px, est, qm)
            if q < D("0.1"):
                continue
            trades.append(cc.trade(a, "buy", q, px, b, until=n))
            meta.append(((a, b), fav, tries))
        if not trades:
            continue
        res = cc.run_sweep(fold, n, P[n - 1], P[n], [], trades)
        for t, m in zip(res["trades"], meta):
            if t["outcome"] == "settled":
                stats["settled"] += 1
                stats["stale_entries"] += int(prev_stale)
            else:
                stats["void"] += 1
                if m[2] + 1 < 3:
                    queue.append((m[0], m[1], m[2] + 1))
    fin = cc.run_final(fold, H[cc.FINAL_K])
    scores = sorted((float(r["score"]) for r in fin["standings"]), reverse=True)
    return dict(max=scores[0], second=scores[1], third=scores[2], fees=float(D(fin["fees"])), pairs=nxt, **stats)


def run_path(args):
    family, idx, seed, sizes, x_by_n = args
    h = make_path(family, seed)
    rng = np.random.default_rng(seed + 99)
    stale = stale_mask(rng)
    c = referee_closes(h, stale)
    live = c[2:cc.LOCK + 1]
    s = float(h[cc.FINAL_K])
    oracle = max(math.floor(10000 / live.min() * 100) / 100 * (s - live.min()), 10000 / (live.max() * 1.0202) * (live.max() - s))
    rows = []
    for n_keys in sizes:
        for pol in POLICIES:
            r = run(h, c, stale, pol, n_keys, seed + 7, x_by_n[n_keys])
            rows.append(dict(family=family, path=idx, keys=n_keys, policy=pol, oracle=round(oracle, 2),
                             stale_share=round(float(stale[2:cc.LOCK + 1].mean()), 4), **{k: (round(v, 2) if isinstance(v, float) else v) for k, v in r.items()}))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--paths", type=int, default=60)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    sizes = (40, 100)
    x_by_n = {40: 0.005, 100: 0.0025}
    fams = ["mc35", "bootstrap", "highvol", "gaps"]
    tasks = [(f, i, 50_000 + 1000 * j + i, sizes, x_by_n) for j, f in enumerate(fams) for i in range(args.paths)]
    t0 = time.time()
    rows = []
    with Pool(args.workers) as pool:
        for r in pool.imap_unordered(run_path, tasks):
            rows += r
    with open(OUT / "stale_policy.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    summary = {}
    for n_keys in sizes:
        base = {(r["family"], r["path"]): r for r in rows if r["keys"] == n_keys and r["policy"] == "REDUCE"}
        for pol in POLICIES:
            rs = [r for r in rows if r["keys"] == n_keys and r["policy"] == pol]
            diffs = [r["max"] - base[(r["family"], r["path"])]["max"] for r in rs]
            summary[f"{pol}@{n_keys}"] = dict(
                runs=len(rs), max_mean=round(float(np.mean([r["max"] for r in rs])), 1),
                capture=round(float(np.mean([r["max"] / r["oracle"] for r in rs if r["oracle"] > 0])), 4),
                vs_REDUCE_mean=round(float(np.mean(diffs)), 2), vs_REDUCE_wins=round(float(np.mean([d > 0 for d in diffs])), 3),
                vs_REDUCE_losses=round(float(np.mean([d < 0 for d in diffs])), 3),
                void_rate=round(sum(r["void"] for r in rs) / max(1, sum(r["void"] + r["settled"] for r in rs)), 4),
                stale_entries=round(float(np.mean([r["stale_entries"] for r in rs])), 2),
                skipped=round(float(np.mean([r["skipped"] for r in rs])), 2), fees=round(float(np.mean([r["fees"] for r in rs])), 1),
                stale_share=round(float(np.mean([r["stale_share"] for r in rs])), 3))
    json.dump(summary, open(OUT / "stale_policy_summary.json", "w"), indent=1)
    print(json.dumps(summary, indent=1))
    print(f"{len(rows)} runs in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
