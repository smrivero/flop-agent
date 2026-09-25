"""Aggregate results/sim_runs.csv into results/summary_*.csv and results/summary.json.

Competition metric: on each path we drop our strategy into a field of rival farms and count how many of
the 3 prize places our keys win, sharing tied places exactly like the fold (a tie across k keys spanning
places splits those places equally). Only the top three scores of each farm can matter, so rows carry
max/second/third.
  strong field: 10 farms of 100 keys running C/D ladders at 0.25%..2% (competent sybil operators)
  weak field  : 10 farms of 100 keys that open all their pairs at the start (split pricing)
"""
import csv
import json
from collections import defaultdict
from pathlib import Path

import numpy as np

RES = Path(__file__).resolve().parents[1] / "results"
rows = list(csv.DictReader(open(RES / "sim_runs.csv")))
for r in rows:
    for k in ("max", "second", "third", "top3_internal", "mean_used", "fees", "oracle", "capture", "best_dd",
              "median_dd_used", "pct_used_positive"):
        r[k] = float(r[k])
    for k in ("keys", "keys_used", "trades", "voids", "path"):
        r[k] = int(r[k])

by_path = defaultdict(dict)
for r in rows:
    by_path[(r["family"], r["path"])][(r["strategy"], r["keys"])] = r

STRONG = [(s, 100) for s in {r["strategy"] for r in rows} if s.startswith(("C_ladder_open[", "D_ladder_ext["))
          and s.count(",") == 0]
WEAK = [("B_all_now[split]", 100)] * 10


def places_won(ours, rivals):
    """ours/rivals: lists of top-3 score lists. Returns the number of the 3 places our keys win."""
    entries = [(s, True) for s in ours] + [(s, False) for rv in rivals for s in rv]
    entries.sort(key=lambda e: -e[0])
    won, place, i = 0.0, 0, 0
    while place < 3 and i < len(entries):
        tied = [e for e in entries[i:] if e[0] == entries[i][0]]
        span = min(len(tied), 3 - place)
        won += span * sum(e[1] for e in tied) / len(tied)
        place += len(tied)
        i += len(tied)
    return won


def competition(r, field):
    path = by_path[(r["family"], r["path"])]
    rivals = [[path[f]["max"], path[f]["second"], path[f]["third"]] for f in field if f in path]
    return places_won([r["max"], r["second"], r["third"]], rivals)


agg = defaultdict(list)
for r in rows:
    r["places_strong"] = competition(r, STRONG)
    r["places_weak"] = competition(r, WEAK)
    agg[(r["strategy"], r["keys"])].append(r)


def stats(rs):
    m = np.array([x["max"] for x in rs])
    return dict(
        runs=len(rs), keys_used=np.mean([x["keys_used"] for x in rs]),
        max_mean=m.mean(), max_median=np.median(m), max_p10=np.percentile(m, 10), max_p90=np.percentile(m, 90),
        second_mean=np.mean([x["second"] for x in rs]), third_mean=np.mean([x["third"] for x in rs]),
        top3_internal_mean=np.mean([x["top3_internal"] for x in rs]), mean_used=np.mean([x["mean_used"] for x in rs]),
        capture_mean=np.mean([x["capture"] for x in rs]), capture_ge_95=np.mean([x["capture"] >= 0.95 for x in rs]),
        fees_mean=np.mean([x["fees"] for x in rs]), trades_mean=np.mean([x["trades"] for x in rs]),
        void_rate=sum(x["voids"] for x in rs) / max(1, sum(x["trades"] + x["voids"] for x in rs)),
        pct_used_positive=np.mean([x["pct_used_positive"] for x in rs]),
        best_dd_median=np.median([x["best_dd"] for x in rs]),
        places_strong=np.mean([x["places_strong"] for x in rs]), places_weak=np.mean([x["places_weak"] for x in rs]))


overall = {k: stats(v) for k, v in agg.items()}
fields = list(next(iter(overall.values())).keys())
with open(RES / "summary_overall.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["strategy", "keys"] + fields)
    for (s, n), st in sorted(overall.items(), key=lambda kv: (-kv[1]["max_mean"])):
        w.writerow([s, n] + [round(st[x], 4) for x in fields])

fam = defaultdict(list)
for r in rows:
    fam[(r["family"], r["strategy"], r["keys"])].append(r)
with open(RES / "summary_by_family.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["family", "strategy", "keys"] + fields)
    for (fa, s, n), rs in sorted(fam.items()):
        st = stats(rs)
        w.writerow([fa, s, n] + [round(st[x], 4) for x in fields])

best = {}
for n in (2, 10, 20, 40, 100):
    cands = {s: st for (s, k), st in overall.items() if k == n}
    best[n] = {
        "by_max_mean": max(cands, key=lambda s: cands[s]["max_mean"]),
        "by_places_strong": max(cands, key=lambda s: cands[s]["places_strong"]),
        "table": {s: {x: round(cands[s][x], 3) for x in ("max_mean", "max_median", "capture_mean",
                                                         "places_strong", "places_weak", "fees_mean",
                                                         "keys_used", "void_rate")} for s in cands}}
fam_best = defaultdict(dict)
for fa in sorted({r["family"] for r in rows}):
    for n in (2, 10, 20, 40, 100):
        cands = {s: np.mean([x["max"] for x in rs]) for (f2, s, k), rs in fam.items() if f2 == fa and k == n}
        s = max(cands, key=cands.get)
        fam_best[fa][n] = [s, round(cands[s], 1),
                           round(float(np.mean([x["oracle"] for x in fam[(fa, s, n)]])), 1)]
json.dump({"best_per_keys": best, "best_per_family": fam_best, "strong_field": STRONG},
          open(RES / "summary.json", "w"), indent=1, default=float)
print("done", len(rows), "runs")
