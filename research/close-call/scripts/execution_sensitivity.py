"""How bad can execution get? Void rate and best score vs the error of our close estimate and our margins.

est_sigma 0.0002 ~ signing 10 s before the sweep with the live Hyperliquid price;
est_sigma 0.001  ~ one full 5-minute move of error (what a stale referee reference, age_s=300, looks like);
est_sigma 0.003  ~ several stale sweeps / a fast market.
Strategy: D ladder 0.5% with 40 keys, on 60 mc35 paths. Settlement by the official fold.
"""
import csv
import sys
from decimal import Decimal as D
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import simulate_strategies as ss  # noqa: E402
from paths import make_path  # noqa: E402

out = []
paths = [make_path("mc35", 11000 + i) for i in range(60)]
for est in (0.0002, 0.001, 0.003):
    for pm, qm in (("0", "0"), ("0.001", "0.003"), ("0.002", "0.006"), ("0.004", "0.012")):
        maxes, voids, trades = [], 0, 0
        for i, p in enumerate(paths):
            scores, roles, stats, fees, dd, _ = ss.simulate(p, ss.LadderExtremes, dict(x=0.005, first="split"), 40,
                                                            i, price_margin=D(pm), qty_margin=D(qm), est_sigma=est)
            maxes.append(max(scores.values()))
            voids += sum(v for k, v in stats.items() if k.startswith("void_"))
            trades += stats["settled"]
        row = dict(est_sigma=est, price_margin=pm, qty_margin=qm, max_mean=round(float(np.mean(maxes)), 1),
                   void_rate=round(voids / max(1, voids + trades), 4), settled=trades, voids=voids)
        out.append(row)
        print(row, flush=True)
res = Path(__file__).resolve().parents[1] / "results" / "execution_sensitivity.csv"
with open(res, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(out[0]))
    w.writeheader()
    w.writerows(out)
