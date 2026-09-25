# close-1: exact rules, read from the fold

Frozen package: `flop-labs/technocore-close-call-challenge` commit `66c1da36538e4b1c685417d2f66922906b13fea0`,
`manifest.json` sha256 `bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa` — the same hash the
referee pinned in its live seed message (`d-close1-price` seq 1). Baseline runs are in `results/baseline/`:
`verify.py` 15/15 artifacts, sample season identical to `sample-season.expected.json`, official unittest 18/18 OK.

Everything below cites `close_call_fold.py` (the generated copy of the code block in `close-call-game.md`).
Every claim marked **[T]** has a test in `tests/test_fold_properties.py` that runs the official `Fold`
(21 tests, all pass).

## 1. Numbers and shapes

- `amount()` accepts a string matching `[0-9]{1,7}(\.[0-9]{1,2})?` and `> 0`. So prices and quantities have at
  most 2 decimals and at most 9,999,999.99; `"0001.50"` is valid, `"1e2"`, `"-1"`, `"1.234"`, `"10000000"` are
  `shape` voids **[T]**. Quantity must also be `>= 0.1` (`shape`).
- Trade id: `[A-Za-z0-9_-]{1,64}`. `until` must be a Python `int` (a JSON float is `shape`).
- DIDs are only checked at mint (`did:key:z6Mk` + 44 base58 chars). In `check()` a key only has to be a minted
  owner.
- All arithmetic is `Decimal` with 60 digits inside `replay()`; nothing is rounded until output. Fees are
  exact (e.g. 2.2614), scores are printed at 6 decimals.

## 2. Accounts, collateral, lots

`Account(cash=10000, lots=[[qty, px], ...], fees)`. Lots are FIFO and all on one side (qty>0 long, <0 short).

- `opening(side, qty)`: `closing = min(qty, max(-side*held, 0))`, `opening = qty - closing`. Only the part
  that does not close an existing position counts as "opening".
- `apply(side, qty, px, fee)`:
  1. `cash -= fee`.
  2. Close FIFO lots of the opposite sign first. A **long** lot sold returns `size * px`. A **short** lot bought
     back returns `size * (2*lot_px - px)`: its collateral `lot_px` plus the gain `lot_px - px`.
  3. The rest opens a new lot at `px` and `cash -= left * px`: **longs and shorts both lock their full price**.
- `value_at(S)`: `cash + Σ q*S` (long lots) `+ Σ |q|*(2p - S)` (short lots).
- Consequences:
  - no leverage, no liquidation; a short loses without bound and a key can end below −10,000 **[T]**;
  - a long's exposure `q*S` always equals its value (constant 1x); a short's exposure/value is `S/(2p−S)`,
    so a winning short de-levers and a losing one levers up (see §6.4).

## 3. The fee and the clawback (`side_fees`)

```
base   = fee_rate * qty * px                 # 1% of the trade value, charged to EACH side
gap    = (close - px) * qty                  # > 0: the buyer paid less than the close
buyer  = max(base, gap)
seller = max(base, -gap)
```

`close` is the sweep's closing price: the Hyperliquid last trade the referee posts as `ref.px` **at this
sweep**. Fees leave play (`self.fees`).

Per contract, with close `c`:
- buyer's all-in cost `p + max(0.01p, c−p) ≥ c`, with equality iff `p ≤ c/1.01`;
- seller's net proceeds `p − max(0.01p, p−c) ≤ c`, with equality iff `p ≥ c/0.99`.

Nobody can get a position better than the close; the counterparty pays for it. Proof and optimum prices in
STRATEGY_ANALYSIS §2 **[T]**.

## 4. What `check()` tests, in order (first failure = void reason)

| # | check | reason |
|---|---|---|
| 1 | dict, id, side, qty/px shape, `until` int, maker/countersigner str, taker `"any"` or str | `shape` |
| 2 | `qty >= 0.1` | `shape` |
| 3 | maker AND countersigner are minted owners | `not_owner` |
| 4 | taker is `"any"` or equals the countersigner | `taker` |
| 5 | id not in `self.settled` (**global across all makers**) | `settled` |
| 6 | `n <= until` | `expired` |
| 7 | `n <= lock` (2556) | `locked` |
| 8 | `abs(px - ref) <= 0.05 * ref` (inclusive; `ref` = previous sweep's reference) | `limits` |
| 9 | funds (below) | `funds` |

**[T]** for the order settled → expired → locked, the inclusive limit edge, and that limits ignore the close and
the global price.

### Funds

`cash >= opening(side, qty) * px + own_fee`, computed with the fee at the **actual** close, against the cash
after every trade applied earlier in the same sweep. Nothing is reserved.

- Closing needs only the fee, but that fee is paid from free cash before the lot releases its collateral. **A
  key that went all-in has ~0 cash and can never close or flip** **[T]**. Keep ≥ ~1.5% cash if a key must be
  able to exit.
- A flip in one trade needs cash for the whole new side; the collateral the closing part frees does not count.
  Two trades in the same sweep (close, then open) work, because the second sees the freed cash **[T]**.
- Self-trade (`maker == countersigner`): funds only need both fees; no position change; both fees are charged,
  including the buyer clawback **[T]**.
- Sizing risk: a buyer sized to exactly `cash/c_est` is voided if the real close ends above `c_est`, because its
  fee (the gap) grows **[T]**. Keep a quantity margin (0.3% worked in simulation with zero funds voids).

## 5. Sweep, settlement order, ids, lock, final

- `sweep(n, ref, close, owners, trades)`: needs a seed and a **strictly increasing int** `n` (gaps allowed).
  It mints the new owners first (only if `n <= lock`, **[T]**), then applies trades in the given order. The
  referee orders them by room stamp, then room name, then sequence number.
- Each trade settles in full for both sides or is void for both. The id joins `settled` only when it settles:
  **a void does not burn the id** **[T]**.
- **Trade ids are global.** If anyone's trade with id `X` settles first, every later trade with id `X` is void
  `settled`, whoever signed it **[T]**. Live, the referee has already voided 16+ trades with reason `settled`.
  Use 128-bit random ids.
- Global price = VWAP of the sweep's settled trades (self-trades included), unchanged if none. It is only
  output: limits use `ref`, fees use `close`, score uses `S` **[T]**.
- Lock: trades at `n > 2556` are `locked` (unless already `expired`/`settled`).
- `final(S)`: `score = value_at(S) − 10000` for every owner, traders or not. Sorted by `(−score, key)`. Tied
  owners share the places they span: 4 keys tied at the top → each gets `places [1,2,3], sharing 4` **[T]**.
- Accounting: `Σ scores + Σ fees = 0` exactly (`zero_sum`), checked by the official tests and **[T]**.

## 6. Properties that matter for a strategy

1. **Value cannot be moved between keys.** A sacrificed key selling 4.9% under the close gives the buyer
   nothing, because the gap comes back as fee. The seller simply loses it **[T]**.
2. **A pair can put the entire 1% fee on one side.** At `p = floor(c/1.01)` the buyer pays exactly `c` and
   the seller pays ~2%. At `p = ceil(c/0.99)` the seller receives exactly `c` **[T]**.
3. **Long and short are asymmetric.** A favoured long gets `floor(10000/c)` contracts. A favoured short at its
   best price needs collateral `2p − c ≈ 1.0202c`, so it gets ~2% fewer contracts **[T]**.
4. **Short convexity.** A winning short can close and re-sell a larger size (its freed cash / price). This
   compounds a falling market; a long cannot gain anything from the same. It needs a cash reserve (point 4
   of §4) and fresh counterparties.
5. **Ties are exact.** Two keys entering all-in at the same sweep and the same pricing get the same score to
   the 6th decimal. Live, 24 of the 25 top PnL entries were tied at 63.91.

## 7. Live facts that the package does not say (from `results/live/`)

- Price post adds `applied` (= previous sweep's `ref.px`, i.e. this sweep's limits basis, 22/22), `for` (the
  sweep the posted `limits` apply to) and `age_s`. `limits` = `[ceil(0.95·ref), floor(1.05·ref)]` (22/22).
- Seed adds `limits` and `for: 1`.
- Flow adds `omitted`: posts list at most ~64 mints/settled/void. The rest are only counted, and full lists
  are in the archived file (hash `file`).
- `missed: [["close1", 188639, 190784]]` at sweep 22: the referee skipped 2,146 `close1` messages. Messages
  there can be lost; use a low-traffic registered room.
- Stale references: `age_s` 300 and 600 (sweeps 14, 15, 20). The reference and fee close were then a 5–10
  minute old price. If our estimate of `c` uses the live Hyperliquid price, a stale close can void or reprice
  our trade.
