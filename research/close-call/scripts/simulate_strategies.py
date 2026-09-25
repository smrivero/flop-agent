"""Multi-key strategy simulator for close-1. Every trade is settled, voided and scored by the OFFICIAL fold.

    python3 scripts/simulate_strategies.py --paths 40 --workers 8      # writes results/sim_runs.csv + summary

A strategy only decides WHEN to open or change positions and between WHICH of our keys, and at what
pricing mode. The engine then prices and sizes the trade with the official fee/funds functions, submits
it to Fold.sweep at the real sweep number (ref = previous sweep's price, close = this sweep's price) and
reads the outcome. Execution is imperfect on purpose: the agent signs using an estimate of the close
(the live price a few seconds before the sweep, Student-t noise), so trades can be voided for funds or
limits exactly as they would be live.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import time
from collections import defaultdict
from decimal import Decimal
from multiprocessing import Pool
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import closecall as cc  # noqa: E402
from paths import FAMILIES, make_path  # noqa: E402

D = Decimal
OUT = Path(__file__).resolve().parents[1] / "results"
KEY_SIZES = (2, 10, 20, 40, 100)
DAY = 288


# ============================================================== strategies

class Strategy:
    """Owns a pool of pairs of keys. `orders(n, c)` returns orders for sweep n given the live price c.

    An order is a dict: buyer, seller, mode, frac (share of each side's cash to use), role info.
    """
    uses_all_keys = True

    def __init__(self, keys, open_px, **kw):
        self.keys = keys
        self.pairs = [(keys[i], keys[i + 1]) for i in range(0, len(keys) - 1, 2)]
        self.next_pair = 0
        self.open = open_px
        self.kw = kw
        self.roles = {}                          # key -> "long*", "short*", "long", "short"

    def take_pair(self):
        if self.next_pair >= len(self.pairs):
            return None
        p = self.pairs[self.next_pair]
        self.next_pair += 1
        return p

    def open_pair(self, mode, frac=D(1)):
        """A pair: key a buys from key b. mode decides which side is favoured."""
        pair = self.take_pair()
        if not pair:
            return []
        a, b = pair
        self.roles[a] = "long*" if mode == "favor_long" else "long"
        self.roles[b] = "short*" if mode == "favor_short" else "short"
        return [dict(buyer=a, seller=b, mode=mode, frac=frac)]

    def orders(self, n, c):
        return []

    def on_void(self, order, reason):
        """Default: retry the same order next sweep (the engine caps retries)."""
        return True


def pricing(mode_cfg, direction):
    """contrarian: a new low favours the long, a new high favours the short."""
    if mode_cfg == "contrarian":
        return "favor_long" if direction < 0 else "favor_short"
    return mode_cfg


class PairNow(Strategy):                         # A (and G/H/I via mode)
    def orders(self, n, c):
        if n == 2:
            return self.open_pair(self.kw.get("mode", "neutral"))
        return []


class AllNow(Strategy):                          # B
    def orders(self, n, c):
        if n != 2:
            return []
        out, i = [], 0
        while self.next_pair < len(self.pairs):
            mode = self.kw.get("mode", "neutral")
            if mode == "split":
                mode = "favor_long" if i % 2 == 0 else "favor_short"
            out += self.open_pair(mode)
            i += 1
        return out


class LadderOpen(Strategy):                      # C: fixed grid of levels around the opening
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.used_dn, self.used_up = 0, 0

    def orders(self, n, c):
        x = self.kw["x"]
        if n == 2:
            return self.open_pair("neutral")
        move = float(c / self.open) - 1
        k = int(math.floor(abs(move) / x + 1e-12))
        if move < 0 and k > self.used_dn:
            self.used_dn = k
            return self.open_pair(pricing(self.kw.get("mode", "contrarian"), -1))
        if move > 0 and k > self.used_up:
            self.used_up = k
            return self.open_pair(pricing(self.kw.get("mode", "contrarian"), 1))
        return []


class LadderExtremes(Strategy):                  # D: a new pair only on a new low/high x beyond the last used
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.lo = self.hi = float(self.open)
        self.start = kw.get("start", 2)
        self.budget = kw.get("budget")           # pairs this ladder may use (None = all)
        self.used = 0

    def _open(self, mode):
        if self.budget is not None and self.used >= self.budget:
            return []
        o = self.open_pair(mode, self.kw.get("frac", D(1)))
        self.used += bool(o)
        return o

    def orders(self, n, c):
        x, cf = self.kw["x"], float(c)
        if n == self.start:
            self.lo = self.hi = cf
            if self.kw.get("first") == "split":        # one favoured long AND one favoured short at the open
                return self._open("favor_long") + self._open("favor_short")
            return self._open(self.kw.get("first", "neutral"))
        if n < self.start:
            return []
        if cf <= self.lo * (1 - x):
            self.lo = cf
            return self._open(pricing(self.kw.get("mode", "contrarian"), -1))
        if cf >= self.hi * (1 + x):
            self.hi = cf
            return self._open(pricing(self.kw.get("mode", "contrarian"), 1))
        return []


class Reserve(Strategy):                         # E: part of the pairs only in the last `days`
    def __init__(self, keys, open_px, **kw):
        super().__init__(keys, open_px, **kw)
        n_res = int(round(len(self.pairs) * kw["reserve"]))
        early = len(self.pairs) - n_res
        self.a = LadderExtremes(keys, open_px, x=kw["x"], budget=early)
        self.b = LadderExtremes(keys, open_px, x=kw["x"] / 2, start=cc.LOCK - kw["days"] * DAY, budget=n_res)
        self.b.pairs = self.a.pairs              # one shared pool of pairs
        self.roles = self.a.roles
        self.b.roles = self.roles

    def orders(self, n, c):
        self.b.next_pair = max(self.b.next_pair, self.a.next_pair)
        self.a.next_pair = max(self.b.next_pair, self.a.next_pair)
        out = self.a.orders(n, c) + self.b.orders(n, c)
        self.a.next_pair = self.b.next_pair = max(self.a.next_pair, self.b.next_pair)
        return out


class Partial(LadderExtremes):                   # F: favoured keys enter with half, top up at the next extreme
    def __init__(self, *a, **kw):
        kw.setdefault("frac", D("0.5"))
        super().__init__(*a, **kw)
        self.half = {1: [], -1: []}              # direction -> pairs waiting for their top-up

    def orders(self, n, c):
        x, cf = self.kw["x"], float(c)
        if n < 2:
            return []
        if n == 2:
            self.lo = self.hi = cf
            return self._open("neutral")
        for direction, hit in ((-1, cf <= self.lo * (1 - x)), (1, cf >= self.hi * (1 + x))):
            if not hit:
                continue
            if direction < 0:
                self.lo = cf
            else:
                self.hi = cf
            mode = pricing("contrarian", direction)
            if self.half[direction]:              # top up the waiting key at the better price
                a, b = self.half[direction].pop(0)
                return [dict(buyer=a, seller=b, mode=mode, frac=D(1))]
            o = self._open(mode)
            if o:
                self.half[direction].append((o[0]["buyer"], o[0]["seller"]))
            return o
        return []


class ShortRebalance(Strategy):                  # J: a favoured short that re-levers after each y% fall
    """Opening: pair0 favour_long, pair1 favour_short. Every time the price is y below the short's last
    (re)open, the short buys back from a fresh key and re-sells a bigger size to another fresh key.
    It keeps 2% cash so it can always pay the closing fee (see RULES_AUDIT: a fully invested key is stuck)."""
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.short = None
        self.last = None
        self.fresh = []
        self.reopen = None

    def orders(self, n, c):
        if n == 2:
            out = self.open_pair("favor_long")
            p = self.take_pair()
            if not p:
                return out
            buyer, self.short = p
            self.roles[buyer], self.roles[self.short] = "long", "short*"
            self.fresh = [k for pr in self.pairs[self.next_pair:] for k in pr]
            self.last = float(c)
            return out + [dict(buyer=buyer, seller=self.short, mode="favor_short", frac=D("0.98"))]
        if self.reopen:                          # re-sell next sweep, sized on the cash the close released
            z2, self.reopen = self.reopen, None
            return [dict(buyer=z2, seller=self.short, mode="favor_short", frac=D("0.98"))]
        if self.short and float(c) <= self.last * (1 - self.kw["y"]) and len(self.fresh) >= 2:
            z1, z2 = self.fresh.pop(0), self.fresh.pop(0)
            self.roles[z1] = self.roles[z2] = "helper"
            self.last = float(c)
            self.reopen = z2
            return [dict(buyer=self.short, seller=z1, mode="favor_long", close_all=True)]
        return []


def configs():
    """(name, class, kwargs, key sizes)"""
    out = []
    for mode in ("neutral", "favor_long", "favor_short"):
        out.append((f"A_pair_now[{mode}]", PairNow, dict(mode=mode), (2,)))
    for mode in ("neutral", "split"):
        out.append((f"B_all_now[{mode}]", AllNow, dict(mode=mode), KEY_SIZES))
    for x in (0.0025, 0.005, 0.01, 0.015, 0.02):
        out.append((f"C_ladder_open[{x:.2%}]", LadderOpen, dict(x=x), KEY_SIZES[1:]))
        out.append((f"D_ladder_ext[{x:.2%}]", LadderExtremes, dict(x=x), KEY_SIZES[1:]))
    for mode in ("neutral", "favor_long", "favor_short"):
        out.append((f"D_ladder_ext[1.00%,{mode}]", LadderExtremes, dict(x=0.01, mode=mode), KEY_SIZES[1:]))
    for r in (0.25, 0.5):
        for days in (1, 2):
            out.append((f"E_reserve[x=1%,r={r},last={days}d]", Reserve, dict(x=0.01, reserve=r, days=days),
                        KEY_SIZES[1:]))
    for x in (0.0025, 0.005, 0.01, 0.02):
        out.append((f"K_ladder_ext_split[{x:.2%}]", LadderExtremes, dict(x=x, first="split"), KEY_SIZES[1:]))
    out.append(("F_partial[x=1%,half]", Partial, dict(x=0.01), KEY_SIZES[1:]))
    for y in (0.01, 0.02):
        out.append((f"J_short_rebalance[y={y:.0%}]", ShortRebalance, dict(y=y), KEY_SIZES[1:]))
    return out


# ============================================================== engine

def simulate(path, strat_cls, kw, n_keys, seed, price_margin=D("0.001"), qty_margin=D("0.003"),
             est_sigma=0.0002, max_tries=3):
    fold = cc.new_fold()
    keys = [cc.fake_did(i) for i in range(n_keys)]
    P = [D(f"{x:.2f}") for x in path]
    fold.seed(str(P[0]))
    cc.run_sweep(fold, 1, P[0], P[1], keys, [])
    strat = strat_cls(keys, P[0], **kw)
    queue = []                                   # (order, tries)
    stats = defaultdict(int)
    peak, dd, entered = {}, defaultdict(float), set()
    noise = np.random.default_rng(seed).standard_t(3, cc.LOCK + 1) / math.sqrt(3) * est_sigma
    for n in range(2, cc.LOCK + 1):
        c_est = D(f"{float(P[n]) * (1 + noise[n]):.2f}")
        new = strat.orders(n, c_est)
        work = [(o, 0) for o in new] + queue
        queue = []
        if work:
            trades, meta = [], []
            for o, tries in work:
                a, b = fold.accounts[o["buyer"]], fold.accounts[o["seller"]]
                px = cc.price_for(o["mode"], c_est, P[n - 1], price_margin)
                if o.get("close_all"):           # buyer closes its whole short
                    q = -a.position
                else:
                    frac = o.get("frac", D(1))
                    q = cc.max_qty(fold, a, b, px, c_est, qty_margin, frac, frac)
                if q < D("0.1"):
                    stats["skipped_small"] += 1
                    continue
                trades.append(cc.trade(o["buyer"], "buy", q, px, o["seller"], until=n))
                meta.append((o, tries))
            if trades:
                res = cc.run_sweep(fold, n, P[n - 1], P[n], [], trades)
                for out, (o, tries) in zip(res["trades"], meta):
                    if out["outcome"] == "settled":
                        stats["settled"] += 1
                        entered.update((o["buyer"], o["seller"]))
                    else:
                        stats["void_" + out["reason"]] += 1
                        if tries + 1 < max_tries and strat.on_void(o, out["reason"]):
                            queue.append((o, tries + 1))
        if n % 12 == 0 and entered:              # hourly mark-to-market drawdown, official value_at
            for k in entered:
                v = float(fold.accounts[k].value_at(P[n]))
                peak[k] = max(peak.get(k, v), v)
                dd[k] = max(dd[k], peak[k] - v)
    final = cc.run_final(fold, P[cc.FINAL_K])
    scores = {r["key"]: float(r["score"]) for r in final["standings"]}
    return scores, strat.roles, stats, float(D(final["fees"])), dd, final


def oracle(path):
    """Best score ONE key could possibly reach: favoured all-in long at the lowest close of sweeps 2..lock
    or favoured short at the highest, held to S (computed with the official fold in tests; formula here)."""
    live = path[2:cc.LOCK + 1]
    s = path[cc.FINAL_K]
    lo, hi = live.min(), live.max()
    long_best = math.floor(10000 / lo * 100) / 100 * (s - lo)
    short_best = 10000 / (hi * 1.0202) * (hi - s)
    return max(long_best, short_best)


ONLY = ()


def run_path(args):
    family, idx, seed, only = args
    path = make_path(family, seed)
    rows = []
    orc = oracle(path)
    for name, cls, kw, sizes in configs():
        if only and not name.startswith(tuple(only)):
            continue
        for n_keys in sizes:
            t0 = time.time()
            scores, roles, stats, fees, dd, _ = simulate(path, cls, kw, n_keys, seed + 7)
            top = sorted(scores.values(), reverse=True) + [0, 0, 0]
            used = [k for k in scores if k in roles]
            best_key = max(scores, key=scores.get)
            rows.append(dict(
                family=family, path=idx, strategy=name, keys=n_keys, keys_used=len(used),
                max=round(top[0], 2), second=round(top[1], 2), third=round(top[2], 2),
                top3_internal=round(top[0] + top[1] + top[2], 2),
                mean_used=round(float(np.mean([scores[k] for k in used])) if used else 0, 2),
                fees=round(fees, 2), trades=stats["settled"],
                voids=sum(v for k, v in stats.items() if k.startswith("void_")),
                void_reasons=json.dumps({k: v for k, v in stats.items() if k.startswith("void_")}),
                pct_used_positive=round(100 * np.mean([scores[k] > 0 for k in used]), 1) if used else 0,
                best_role=roles.get(best_key, "idle"), best_dd=round(dd.get(best_key, 0), 2),
                median_dd_used=round(float(np.median([dd.get(k, 0) for k in used])), 2) if used else 0,
                oracle=round(orc, 2), capture=round(top[0] / orc, 4) if orc > 0 else 0,
                S=float(path[cc.FINAL_K]), open=float(path[0]),
                path_min=float(path[2:cc.LOCK + 1].min()), path_max=float(path[2:cc.LOCK + 1].max()),
                seconds=round(time.time() - t0, 3)))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--paths", type=int, default=40, help="paths per family")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--families", default=",".join(FAMILIES))
    ap.add_argument("--only", default="", help="comma-separated strategy name prefixes to run")
    ap.add_argument("--out", default="sim_runs.csv")
    args = ap.parse_args()
    only = tuple(x for x in args.only.split(",") if x)
    fams = list(FAMILIES)
    tasks = [(f, i, 1000 * fams.index(f) + i, only) for f in args.families.split(",") for i in range(args.paths)]
    t0 = time.time()
    rows = []
    with Pool(args.workers) as pool:
        for i, r in enumerate(pool.imap_unordered(run_path, tasks)):
            rows += r
            if i % 20 == 0:
                print(f"{i + 1}/{len(tasks)} paths, {time.time() - t0:.0f}s", flush=True)
    OUT.mkdir(exist_ok=True)
    with open(OUT / args.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} runs in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
