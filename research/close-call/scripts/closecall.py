"""Shared helpers for the close-1 research: load the OFFICIAL fold, build trades, price and size them.

Nothing here re-implements settlement. Every balance, fee, void reason and score comes from
`close_call_fold.Fold` imported from the frozen package (commit 66c1da3). This module only decides
which trades to submit and at what price/quantity, the way a real agent would.
"""
from __future__ import annotations

import hashlib
import os
import sys
import uuid
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal, localcontext
from pathlib import Path

PACKAGE = Path(os.environ.get("CLOSE_CALL_PACKAGE",
                              Path(__file__).resolve().parents[4] / "technocore-close-call-challenge"))
sys.path.insert(0, str(PACKAGE))
import close_call_fold as official  # noqa: E402  (the oracle)

Fold = official.Fold
CENT = Decimal("0.01")
MINT = Decimal("10000")
LOCK = 2556          # contest.json lock_sweep
FINAL_K = 2568       # 10:00 UTC on 4 Oct = 12 sweeps after the lock
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def fake_did(i: int, tag: str = "") -> str:
    """A syntactically valid, UNIQUE did:key for simulation only (no private key exists for it)."""
    n = int.from_bytes(hashlib.sha256(f"close-call-sim|{tag}|{i}".encode()).digest(), "big")
    body = ""
    for _ in range(44):
        n, r = divmod(n, 58)
        body += B58[r]
    return "did:key:z6Mk" + body


def cents(x) -> Decimal:
    return Decimal(str(x)).quantize(CENT)


def floor_cent(x: Decimal) -> Decimal:
    return x.quantize(CENT, rounding=ROUND_FLOOR)


def ceil_cent(x: Decimal) -> Decimal:
    return x.quantize(CENT, rounding=ROUND_CEILING)


def new_fold() -> Fold:
    return Fold({"lock_sweep": LOCK})


def trade(maker: str, side: str, qty: Decimal, px: Decimal, countersigner: str, until: int,
          taker: str | None = None, tid: str | None = None) -> dict:
    return {"id": tid or uuid.uuid4().hex, "maker": maker, "side": side, "qty": str(qty), "px": str(px),
            "taker": taker or countersigner, "until": until, "countersigner": countersigner}


# ---------------------------------------------------------------- pricing (proved in STRATEGY_ANALYSIS.md)

def price_for(mode: str, c_est: Decimal, ref: Decimal, margin: Decimal = Decimal("0.001")) -> Decimal:
    """Price for a pair trade in the next sweep.

    favor_long : p = floor(c/1.01)  -> buyer's cost is exactly the close c, seller absorbs the fee
    favor_short: p = ceil(c/0.99)   -> seller receives exactly c, buyer absorbs the fee
    neutral    : p = c              -> both pay 1%
    `margin` pushes the price a little further so a small move of the close before the sweep does not
    push the favoured side back into the flat 1% fee. The result is clamped into the +-5% limits.
    """
    if mode == "favor_long":
        p = floor_cent(c_est / Decimal("1.01") / (1 + margin))
    elif mode == "favor_short":
        p = ceil_cent(c_est / Decimal("0.99") * (1 + margin))
    elif mode == "neutral":
        p = cents(c_est)
    else:
        raise ValueError(mode)
    lo, hi = ceil_cent(ref * Decimal("0.95")), floor_cent(ref * Decimal("1.05"))
    return min(max(p, lo), hi)


def required_cash(fold: Fold, acct, side: int, qty: Decimal, px: Decimal, close: Decimal, as_maker_side: int):
    """Cash the OFFICIAL funds check demands from `acct` for this trade at a hypothetical close."""
    mk_fee, tk_fee = fold.side_fees(as_maker_side, qty, px, close)
    fee = mk_fee if side == as_maker_side else tk_fee
    return acct.opening(side, qty) * px + fee


def max_qty(fold: Fold, buyer, seller, px: Decimal, c_est: Decimal, qmargin: Decimal,
            buyer_frac=Decimal(1), seller_frac=Decimal(1)) -> Decimal:
    """Largest 0.01-step quantity both sides can fund under the official check, for any close within
    c_est*(1 +- qmargin). Binary search over the official Fold.side_fees / Account.opening."""
    closes = (c_est * (1 - qmargin), c_est, c_est * (1 + qmargin))
    lo, hi = Decimal(0), Decimal(int(max(buyer.cash, seller.cash) / px * 2) + 1)

    def ok(q):
        for c in closes:
            if buyer.cash * buyer_frac < required_cash(fold, buyer, 1, q, px, c, 1):
                return False
            if seller.cash * seller_frac < required_cash(fold, seller, -1, q, px, c, 1):
                return False
        return True
    while hi - lo > CENT:
        mid = floor_cent((lo + hi) / 2)
        if mid <= lo:
            break
        if ok(mid):
            lo = mid
        else:
            hi = mid
    return lo


def run_sweep(fold: Fold, n: int, ref: Decimal, close: Decimal, owners, trades):
    with localcontext() as ctx:
        ctx.prec = 60
        return fold.sweep(n, str(ref), str(close), owners, trades)


def run_final(fold: Fold, s: Decimal):
    with localcontext() as ctx:
        ctx.prec = 60
        return fold.final(str(s))
