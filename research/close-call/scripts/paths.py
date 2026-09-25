"""Synthetic xyz:NVDA paths, one price per sweep k = 0..2568 (k=0 is the 12:00 UTC seed on Fri 25 Sep,
k=2556 the lock at 09:00 UTC Sun 4 Oct, k=2568 = S at 10:00 UTC).

Calibrated on Hyperliquid xyz:NVDA candles (results/calibration.txt): weekday vol 30-43%/yr, weekend
11-17%/yr, heavy tails (kurtosis ~20). Every family = a deterministic log-shape + Student-t(3) noise
with that weekday/weekend/US-session schedule. `bootstrap` resamples real 5-minute returns.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

K = 2569
HOURS = np.arange(K) * 5 / 60                # hours since Fri 12:00 UTC
DOW_HOUR = (HOURS + 4 * 24 + 12) % (7 * 24)  # Mon 00:00 = 0
WEEKEND = DOW_HOUR >= 5 * 24
HOD = DOW_HOUR % 24
US = (~WEEKEND) & (HOD >= 13.5) & (HOD < 20)
PER_YEAR = 365 * 288


def schedule(weekday_vol: float) -> np.ndarray:
    """Per-sweep sigma: US session 2x the rest of the weekday, weekend at ~1/3 of weekday vol."""
    raw = np.where(WEEKEND, 0.35, np.where(US, 2.0, 0.6))
    wd = ~WEEKEND
    raw = raw / np.sqrt((raw[wd] ** 2).mean())      # weekday rms = 1
    return weekday_vol / np.sqrt(PER_YEAR) * raw


def t_noise(rng, n, df=3):
    x = rng.standard_t(df, n)
    return x / np.sqrt(df / (df - 2))


def shape(points):
    """Piecewise-linear log-drift through (fraction of season, cumulative log move) points."""
    xs, ys = zip(*points)
    return np.interp(np.linspace(0, 1, K), xs, ys)


FAMILIES = {
    "lateral":     dict(vol=0.30, ou=0.02),
    "uptrend":     dict(vol=0.35, pts=[(0, 0), (1, 0.10)]),
    "downtrend":   dict(vol=0.35, pts=[(0, 0), (1, -0.10)]),
    "highvol":     dict(vol=0.70),
    "lowvol":      dict(vol=0.15),
    "dip_recover": dict(vol=0.30, pts=[(0, 0), (0.4, -0.08), (1, 0.0)]),
    "rally_fall":  dict(vol=0.30, pts=[(0, 0), (0.4, 0.08), (1, 0.0)]),
    "v_shape":     dict(vol=0.30, pts=[(0, 0), (0.5, -0.09), (1, 0.03)]),
    "inv_v":       dict(vol=0.30, pts=[(0, 0), (0.5, 0.09), (1, -0.03)]),
    "gaps":        dict(vol=0.30, jumps=4),
    "mc20":        dict(vol=0.20),
    "mc35":        dict(vol=0.35),
    "mc50":        dict(vol=0.50),
    "bootstrap":   dict(bootstrap=True),
}


def _real_returns():
    here = Path(__file__).resolve().parents[1] / "results" / "hl_nvda_5m.json"
    c = json.loads(here.read_text())
    t = np.array([x["t"] for x in c]) / 1000
    p = np.array([float(x["c"]) for x in c])
    r = np.diff(np.log(p))
    wd = ((t[1:] // 86400 + 4) % 7) >= 5          # 1970-01-01 was a Thursday
    return r, wd


def make_path(family: str, seed: int, s0: float = 226.14) -> np.ndarray:
    f = FAMILIES[family]
    rng = np.random.default_rng(seed)
    if f.get("bootstrap"):
        r, wd = _real_returns()
        out, i = np.zeros(K - 1), 0
        while i < K - 1:                           # blocks of 1h from the matching weekday/weekend pool
            pool = np.flatnonzero(wd == WEEKEND[i + 1])
            j = int(rng.choice(pool[pool < len(r) - 12]))
            n = min(12, K - 1 - i)
            out[i:i + n] = r[j:j + n]
            i += n
        logp = np.concatenate([[0], np.cumsum(out - r.mean())])   # remove the pool's drift, not this path's
    else:
        sig = schedule(f["vol"])
        eps = t_noise(rng, K) * sig
        eps[0] = 0
        if f.get("jumps"):
            for j in rng.integers(24, K - 24, f["jumps"]):
                eps[j] += rng.choice([-1, 1]) * rng.uniform(0.03, 0.07)
        if f.get("ou"):                            # mean reversion toward the open (lateral market)
            logp = np.zeros(K)
            theta = f["ou"] / 12
            for k in range(1, K):
                logp[k] = logp[k - 1] * (1 - theta) + eps[k]
        else:
            logp = np.cumsum(eps)
        if f.get("pts"):
            logp = logp + shape(f["pts"])
    return np.round(s0 * np.exp(logp), 2)
