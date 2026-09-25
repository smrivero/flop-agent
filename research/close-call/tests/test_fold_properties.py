"""Properties of the OFFICIAL close-1 fold that matter for strategy. Each test drives close_call_fold.Fold
directly (frozen package, commit 66c1da3). Run from research/close-call:

    python3 -m unittest discover -s tests -v
"""
import sys
import unittest
from decimal import Decimal as D
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import closecall as cc  # noqa: E402

A, B, C, E = (cc.fake_did(i, "t") for i in range(4))
C0 = D("226.14")          # the real seed of close-1


def season(owners=(A, B, C, E)):
    f = cc.new_fold()
    f.seed(str(C0))
    cc.run_sweep(f, 1, C0, C0, list(owners), [])
    return f


def buy(maker, seller, qty, px, tid=None, until=99):
    return cc.trade(maker, "buy", D(qty), D(px), seller, until, tid=tid)


def sell(maker, buyer, qty, px, tid=None, until=99):
    return cc.trade(maker, "sell", D(qty), D(px), buyer, until, tid=tid)


def score(f, key, s):
    return f.accounts[key].value_at(D(s)) - cc.MINT


def outcome(res, i=0):
    t = res["trades"][i]
    return "settled" if t["outcome"] == "settled" else "void:" + t["reason"]


class SimulationHarness(unittest.TestCase):
    def test_fake_dids_are_unique_and_valid(self):
        """Regression: an early generator collided (58 unique of 100), silently merging simulated keys."""
        dids = [cc.fake_did(i) for i in range(1000)] + [cc.fake_did(i, "t") for i in range(1000)]
        self.assertEqual(len(set(dids)), 2000)
        self.assertTrue(all(cc.official.DID.fullmatch(d) for d in dids))


class OptimalPricing(unittest.TestCase):
    """STRATEGY_ANALYSIS §2: buyer cost = p + max(1%·p, c-p) >= c, equality iff p <= c/1.01;
    seller proceeds = p - max(1%·p, p-c) <= c, equality iff p >= c/0.99."""

    def grid(self):
        lo, hi = cc.ceil_cent(C0 * D("0.95")), cc.floor_cent(C0 * D("1.05"))
        p = lo
        while p <= hi:
            yield p
            p += D("0.01")

    def test_buyer_never_pays_less_than_the_close_and_pays_exactly_it_below_c_over_101(self):
        best = []
        for p in self.grid():
            f = season()
            self.assertEqual(outcome(cc.run_sweep(f, 2, C0, C0, [], [buy(A, B, "1", p)])), "settled")
            s = score(f, A, C0)                    # marked at the close: the buyer's cost over c
            self.assertLessEqual(s, 0)
            if s == 0:
                best.append(p)
        self.assertEqual(max(best), cc.floor_cent(C0 / D("1.01")))   # 223.90
        self.assertEqual(min(best), cc.ceil_cent(C0 * D("0.95")))    # every lower price in the limits works too

    def test_seller_never_receives_more_than_the_close_and_gets_exactly_it_above_c_over_099(self):
        best = []
        for p in self.grid():
            f = season()
            cc.run_sweep(f, 2, C0, C0, [], [sell(A, B, "1", p)])
            s = score(f, A, C0)
            self.assertLessEqual(s, 0)
            if s == 0:
                best.append(p)
        self.assertEqual(min(best), cc.ceil_cent(C0 / D("0.99")))    # 228.43

    def test_favoured_short_is_best_at_the_lowest_price_that_still_costs_nothing(self):
        """Above c/0.99 the fee is exactly the premium, but the short's collateral 2p-c keeps growing,
        so a full-size short gets fewer contracts. Scan p with max size, score at S = 0.9c."""
        results = {}
        for p in self.grid():
            f = season()
            q = cc.max_qty(f, f.accounts[B], f.accounts[A], p, C0, D(0))
            cc.run_sweep(f, 2, C0, C0, [], [sell(A, B, str(q), p)])
            results[p] = score(f, A, C0 * D("0.9"))
        self.assertEqual(max(results, key=results.get), cc.ceil_cent(C0 / D("0.99")))

    def test_neutral_price_costs_each_side_one_percent(self):
        f = season()
        cc.run_sweep(f, 2, C0, C0, [], [buy(A, B, "10", C0)])
        self.assertEqual(score(f, A, C0), -D("22.614"))
        self.assertEqual(score(f, B, C0), -D("22.614"))


class Capacity(unittest.TestCase):
    def test_long_gets_2_percent_more_contracts_than_a_short_at_their_best_prices(self):
        f = season()
        pl = cc.price_for("favor_long", C0, C0, D(0))
        ql = cc.max_qty(f, f.accounts[A], f.accounts[B], pl, C0, D(0))
        ps = cc.price_for("favor_short", C0, C0, D(0))
        qs = cc.max_qty(f, f.accounts[C], f.accounts[E], ps, C0, D(0))    # E is the favoured seller
        self.assertEqual(ql, D("44.22"))                                   # floor(10000 / 226.14)
        self.assertEqual(outcome(cc.run_sweep(f, 2, C0, C0, [], [buy(A, B, ql, pl), buy(C, E, qs, ps)]), 1),
                         "settled")
        self.assertAlmostEqual(float(ql / qs), 1.0202, places=2)

    def test_a_fully_invested_key_cannot_close_its_position(self):
        """Closing needs cash >= the fee (>= 1% of value), and all-in leaves ~0 cash: the key is stuck."""
        f = season()
        pl = cc.price_for("favor_long", C0, C0, D(0))
        cc.run_sweep(f, 2, C0, C0, [], [buy(A, B, "44.22", pl)])
        self.assertLess(f.accounts[A].cash, D(1))
        res = cc.run_sweep(f, 3, C0, C0, [], [sell(A, C, "44.22", C0)])
        self.assertEqual(outcome(res), "void:funds")

    def test_a_key_with_a_2_percent_reserve_can_close(self):
        f = season()
        pl = cc.price_for("favor_long", C0, C0, D(0))
        cc.run_sweep(f, 2, C0, C0, [], [buy(A, B, "43.30", pl)])
        self.assertEqual(outcome(cc.run_sweep(f, 3, C0, C0, [], [sell(A, C, "43.30", C0)])), "settled")

    def test_a_short_can_score_below_minus_the_mint(self):
        f = season()
        cc.run_sweep(f, 2, C0, C0, [], [buy(B, A, "40", C0)])            # A shorts 40 at 226.14
        self.assertLess(score(f, A, "500.00"), -cc.MINT)


class ClawbackAndTransfers(unittest.TestCase):
    def test_a_sacrificed_key_cannot_hand_value_to_another(self):
        """B sells to A 4.9% under the close: A's gain is taken back as fee, B just loses it."""
        f = season()
        px = cc.ceil_cent(C0 * D("0.951"))
        cc.run_sweep(f, 2, C0, C0, [], [buy(A, B, "10", px)])
        self.assertEqual(score(f, A, C0), 0)
        self.assertLess(score(f, B, C0), -D("100"))

    def test_zero_sum_score_plus_fees(self):
        f = season()
        cc.run_sweep(f, 2, C0, D("229.00"), [], [buy(A, B, "20", "224.00"), sell(C, A, "5", "230.10"),
                                               buy(E, E, "1", "226.00"), buy(B, C, "7.77", "221.11")])
        cc.run_sweep(f, 9, D("229.00"), D("215.35"), [], [sell(A, E, "12.34", "218.00")])
        fin = cc.run_final(f, D("240.01"))
        self.assertEqual(D(fin["zero_sum"]), 0)


class Ordering(unittest.TestCase):
    def test_trade_ids_are_global_across_makers(self):
        """An id settled by ANY maker voids every later trade with that id, even between other keys."""
        f = season()
        res = cc.run_sweep(f, 2, C0, C0, [], [buy(C, E, "1", C0, tid="nvda1"), buy(A, B, "1", C0, tid="nvda1")])
        self.assertEqual([outcome(res, 0), outcome(res, 1)], ["settled", "void:settled"])

    def test_a_void_does_not_burn_the_id(self):
        f = season()
        res = cc.run_sweep(f, 2, C0, C0, [], [buy(A, B, "100", C0, tid="x1")])
        self.assertEqual(outcome(res), "void:funds")
        res = cc.run_sweep(f, 3, C0, C0, [], [buy(A, B, "1", C0, tid="x1")])
        self.assertEqual(outcome(res), "settled")

    def test_flip_in_one_trade_needs_cash_for_the_new_side_but_two_trades_in_one_sweep_work(self):
        f = season()
        cc.run_sweep(f, 2, C0, C0, [], [buy(A, B, "43", C0)])             # A long 43, ~275 cash left
        res = cc.run_sweep(f, 3, C0, C0, [], [sell(A, C, "86", C0)])
        self.assertEqual(outcome(res), "void:funds")
        res = cc.run_sweep(f, 4, C0, C0, [], [sell(A, C, "43", C0), sell(A, E, "40", C0)])
        self.assertEqual([outcome(res, 0), outcome(res, 1)], ["settled", "settled"])
        self.assertEqual(f.accounts[A].position, D("-40"))

    def test_check_order_settled_then_expired_then_locked(self):
        f = season()
        cc.run_sweep(f, 2, C0, C0, [], [buy(A, B, "1", C0, tid="z")])
        res = cc.run_sweep(f, 2600, C0, C0, [], [buy(A, B, "1", C0, tid="z", until=5),
                                                  buy(A, B, "1", C0, tid="y", until=5),
                                                  buy(A, B, "1", C0, tid="w", until=9999)])
        self.assertEqual([t["reason"] for t in res["trades"]], ["settled", "expired", "locked"])

    def test_no_mint_after_the_lock(self):
        f = season(owners=(A, B))
        res = cc.run_sweep(f, cc.LOCK + 1, C0, C0, [C], [])
        self.assertEqual(res["minted"], [])


class LimitsAndShapes(unittest.TestCase):
    def test_limit_edge_is_inclusive(self):
        hi = C0 * D("1.05")                                                # 237.447 -> 237.44 is inside
        f = season()
        res = cc.run_sweep(f, 2, C0, D("240"), [], [buy(A, B, "1", cc.floor_cent(hi)),
                                                     buy(C, E, "1", cc.floor_cent(hi) + D("0.01"))])
        self.assertEqual([outcome(res, 0), outcome(res, 1)], ["settled", "void:limits"])

    def test_limits_use_the_previous_reference_not_the_close_or_the_global(self):
        f = season()
        res = cc.run_sweep(f, 2, D("200.00"), D("300.00"), [], [buy(A, B, "1", "209.00")])
        self.assertEqual(outcome(res), "settled")                         # 300 close does not move limits

    def test_number_shapes(self):
        f = season()
        cases = [("0.1", "settled"), ("0.09", "void:shape"), ("1e2", "void:shape"), ("-1", "void:shape"),
                 ("0001.50", "settled"), ("10000000", "void:shape"), ("1.234", "void:shape")]
        for i, (qty, want) in enumerate(cases):
            t = cc.trade(A, "buy", D(0), C0, B, 99)
            t["qty"] = qty
            got = outcome(cc.run_sweep(f, 10 + i, C0, C0, [], [t]))
            self.assertEqual(got, want, qty)

    def test_self_trade_pays_both_fees_and_moves_the_global_price_only(self):
        f = season()
        res = cc.run_sweep(f, 2, C0, C0, [], [buy(A, A, "10", "220.00")])
        self.assertEqual(f.accounts[A].position, 0)
        self.assertEqual(res["global_price"], "220.00")
        # buyer pays the clawback (226.14-220)*10 = 61.40, seller the base 22.00
        self.assertEqual(score(f, A, C0), -D("83.40"))


class Execution(unittest.TestCase):
    def test_all_in_sized_on_an_estimate_is_voided_if_the_close_ticks_up(self):
        """Funds use the fee at the actual close: a buyer sized at exactly cash/c_est fails if c > c_est."""
        f = season()
        pl = cc.price_for("favor_long", C0, C0, D(0))
        q = cc.max_qty(f, f.accounts[A], f.accounts[B], pl, C0, D(0))
        res = cc.run_sweep(f, 2, C0, C0 + D("0.50"), [], [buy(A, B, q, pl)])
        self.assertEqual(outcome(res), "void:funds")
        q2 = cc.max_qty(f, f.accounts[A], f.accounts[B], pl, C0, D("0.003"))
        self.assertEqual(outcome(cc.run_sweep(f, 3, C0, C0 + D("0.50"), [], [buy(A, B, q2, pl)])), "settled")

    def test_identical_entries_tie_and_share_places(self):
        keys = [cc.fake_did(i, "tie") for i in range(8)]
        f = cc.new_fold()
        f.seed(str(C0))
        cc.run_sweep(f, 1, C0, C0, keys, [])
        pl = cc.price_for("favor_long", C0, C0, D(0))
        cc.run_sweep(f, 2, C0, C0, [], [buy(keys[i], keys[i + 1], "44.22", pl) for i in range(0, 8, 2)])
        fin = cc.run_final(f, D("240.00"))
        top = fin["standings"][:4]
        self.assertEqual({r["score"] for r in top}, {top[0]["score"]})
        self.assertEqual([(r["places"], r["sharing"]) for r in top], [([1, 2, 3], 4)] * 4)


if __name__ == "__main__":
    unittest.main()
