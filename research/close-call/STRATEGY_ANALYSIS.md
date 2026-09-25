# close-1: multi-key strategy analysis

All numbers below come from `results/sim_runs.csv`: **152,600 full seasons** = 14 path families × 100 paths ×
109 strategy/key-count configurations. Every trade was settled, voided and scored by the OFFICIAL
`close_call_fold.Fold`. The strategies only decide when to trade, between which of our keys and at which
pricing mode. Summaries: `results/summary_overall.csv`, `results/summary_by_family.csv`, `results/summary.json`.

## 1. What a key's score is

Notation: `W = 10000` is the mint, `c` the close of the sweep where a key trades, `S` the final price.

A key that goes all-in once at sweep close `c` and holds to `S` scores, by `value_at`:

- long: `q·(S − p) − fee`, where `q·p + fee ≤ W`;
- short: `q·(p − S) − fee`, where `q·p + fee ≤ W` (the short also locks `p`).

Because the clawback forbids a position better than `c` (§2), the best a key can do is:

- **long:** `W·(S/c − 1)`, exactly, with `q = floor(W/c)`;
- **short:** `W·(1 − S/c)/1.0202`. A favoured short needs `2p − c ≈ 1.0202c` of collateral per contract.

There is no leverage, and no way to move value from one of our keys to another (tested). So **every key is
one lottery ticket on `|S − c|`**. The only levers are *which `c`* each ticket gets (entry timing) and *who
pays the 1% fee* (pricing inside a pair).

The ceiling for one key on a path (the "oracle") is a favoured long entered at the lowest close of sweeps
2..2556, or a favoured short at the highest. On 765 real 9-day windows of xyz:NVDA (1h candles, Mar–Sep
2026) this ceiling is **+680 POLF median, +1,080 at p90** (`results/calibration.txt`).

## 2. Optimal prices (proof, checked on every cent of the ±5% band by the fold)

Buyer's all-in cost per contract at price `p` and close `c`:

`B(p) = p + max(0.01p, c − p)`
- if `p ≤ c/1.01`: `c − p ≥ 0.01p`, so `B = c`;
- if `p > c/1.01`: `B = 1.01p > c`.

So `min B = c`, reached by **every** `p ≤ c/1.01`. Among those, the seller (our other key) receives
`p − 0.01p = 0.99p`, which is largest at the largest such `p`: **`p*_long = floor_cent(c/1.01)`**. The seller
then loses `c − 0.99p ≈ 1.98%`.

Seller's net per contract: `N(p) = p − max(0.01p, p − c)`
- if `p ≥ c/0.99`: `N = c`;
- else: `N = 0.99p < c`.

The short also locks `p + fee = 2p − c` (for `p ≥ c/0.99`) per contract, which grows with `p`. Return per unit
of capital `(N − S)/(2p − c)` is therefore maximal at the smallest `p` with `N = c`:
**`p*_short = ceil_cent(c/0.99)`**. Below it, `(0.99p − S)/(1.01p)` increases with `p`.

Checked in `tests/test_fold_properties.py::OptimalPricing`. With the real seed `c = 226.14`:

- the buyer's cost is exactly `c` for every cent from 214.84 up to **223.90** (= floor(226.14/1.01)) and above
  `c` from 223.91 on;
- the seller's net is exactly `c` from **228.43** (= ceil(226.14/0.99)) on;
- a full-size short scored at `S = 0.9c` is best at exactly 228.43.

Neutral price `p = c`: both sides pay 1%.

Execution version: `c` is unknown when we sign. We price at `c_est·(1 ∓ 0.1%)` so a small tick of the close
does not push the favoured side back into the flat fee, and size at `c_est·(1 + 0.3%)` so the funds check
survives it.

## 3. Setup of the simulation

- **Paths** (`scripts/paths.py`): one price per sweep, 2,569 points (seed, 2,556 sweeps, S one hour after the
  lock). The schedule is the real one: weekday vs weekend, US session 2x. Noise is Student-t(3), calibrated on
  Hyperliquid xyz:NVDA (weekday 30–43%/yr, weekend 11–17%, kurtosis ~20).
  - Families: `lateral` (mean-reverting), `uptrend` / `downtrend` (±10%), `highvol` (70%), `lowvol` (15%),
    `dip_recover`, `rally_fall`, `v_shape`, `inv_v`, `gaps` (4 jumps of 3–7%), `mc20` / `mc35` / `mc50`
    (plain Monte Carlo) and `bootstrap` (1-hour blocks of real 5-minute returns).
- **Execution:** at sweep n the agent sees the live price with Student-t error σ=0.02% (~10 s before the
  sweep). It prices with a 0.1% margin, sizes with the official funds check at a close ±0.3%, and sets
  `until = n`. Voids retry up to twice at the next sweeps.
- **Metrics** per run: best, 2nd and 3rd score of our keys, `top3_internal`, mean of used keys, fees, keys
  used, trades, voids, % of used keys positive, drawdown of the best key.
  - **capture** = best score / oracle, where the oracle is the best single-key score possible on that path.
  - **places vs a field:** how many of the 3 prize places our keys win, sharing ties like the fold. The
    **strong field** is 10 rival farms of 100 keys running C/D ladders at 0.25–2%. The **weak field** is 10
    farms of 100 keys opening all pairs at the start.

Strategies: **A** one pair now · **B** all pairs now (`split` = alternate favoured long/short) ·
**C** ladder at fixed ±x steps from the opening · **D** ladder on new extremes x beyond the last used ·
**K** = D with a *split start* (one favoured-long and one favoured-short pair at the opening) ·
**E** D with 25–50% of the pairs reserved for the last 1–2 days · **F** favoured keys enter with half and
top up at the next extreme · **J** a favoured short that closes and re-sells bigger after each y% fall
(short convexity). Ladder pricing is *contrarian* by default: a new low favours the long, a new high favours
the short. **G/H/I** = the same ladder with every pair favour-long / favour-short / neutral.

## 4. Results

### Best configuration per number of keys (means over all 1,400 paths)

| keys | best strategy | best score: mean / median / p10 / p90 | 2nd | 3rd | capture | P(capture≥95%) | places vs strong field | vs weak field | fees | keys used |
|---|---|---|---|---|---|---|---|---|---|---|
| 2 | A pair now, favour-long | 387 / 230 / −44 / 1086 | −594 | 0 | 0.39 | 0.06 | 0.08 | 0.05 | 207 | 2 |
| 10 | C/D/K ladder 2% | 672 / 600 / 92 / 1310 | 456 | 304 | 0.74 | 0.13 | 0.06–0.18 | 1.16 | 805 | 8 |
| 20 | **K split ladder 1%** | 745 / 659 / 193 / 1396 | 613 | 507 | 0.89 | 0.38 | 0.24 | 1.71 | 1650 | 16 |
| 40 | **K split ladder 0.5%** | 783 / 713 / 210 / 1432 | 701 | 626 | 0.95 | 0.66 | 0.42 | 2.16 | 3011 | 29 |
| 100 | **K split ladder 0.25%** | 806 / 741 / 220 / 1464 | 755 | 704 | 0.98 | 0.87 | 0.63 | 2.47 | 5616 | 54 (p90 92) |

What this shows:

- **More keys ≈ a finer grid of entry prices.** The best key's score rises fast up to 20 keys, then slowly
  (+38 from 40 to 100 keys). Its chance of being at the path's extreme rises a lot more: P(capture≥95%)
  goes 0.38 → 0.66 → 0.87. In a field full of identical copies, that is what wins places.
- **The threshold must match the key budget:** 2% for 10 keys, 1% for 20, 0.5% for 40, 0.25% for 100. With
  too fine a grid the pairs run out before the extreme. With too coarse a grid you miss it.
- Against a **strong field**, even 100 keys win on average 0.63 of the 3 places. Against a **weak field**,
  40 keys already win 2.2 of 3.

### Pricing: G / H / I (same D 1% ladder, 40 keys)

| pricing | best | 2nd | 3rd | places vs strong field |
|---|---|---|---|---|
| **contrarian** (low → favour long, high → favour short) | **748** | 606 | 492 | **0.152** |
| G: always favour long | 689 | 579 | 479 | 0.098 |
| H: always favour short | 673 | 564 | 467 | 0.088 |
| I: neutral (both pay 1%) | 679 | 570 | 472 | 0.027 |

Favouring the side that is at an extreme is worth ~+10% of score. It also breaks ties against rivals who
pay the 1%, which is why neutral pricing almost never wins a place.

### Other ideas that did not help (40 keys unless noted)

| strategy | best | vs D 1% (748) | why |
|---|---|---|---|
| E reserve 25% for the last day | 748 | same, +544 fees | the extremes are not concentrated at the end; reserved keys are mostly unused |
| E reserve 50% for the last 2 days | 736 | −12 | fewer keys when the extremes happen |
| F half entry, top up later | 586 | −162 | a key entered with half its capital caps its own score at half |
| J short re-levering after 1% / 2% falls | 560 / 548 | −190 | real convexity, but it spends keys on helpers and only pays in long down-trends |
| B all pairs at the start (split) | 468 ×3 (tied) | −280 | identical tickets; wins all 3 places only when the start is the extreme (monotone trends) |

### By path family (40 keys; best mean score / mean oracle)

At 40 keys the best ladder captures **94–99% of the oracle in every family**: lateral 277/286, lowvol 204/216,
mc35 544/557, bootstrap 455/467, gaps 1174/1215, v_shape 1279/1338, uptrend 1142/1156. What changes between
families is the size of the prize: ~200–470 POLF in quiet markets, ~1,100–1,340 in trends and V shapes.

With 2 keys, capture goes from 10% (lateral) and 23% (V, dip-recover) to 90–92% (clean up/down trends).
A single pair is only good when the opening happens to be the extreme. Details:
`results/summary.json` → `best_per_family`.

### Execution sensitivity (`results/execution_sensitivity.csv`, K 0.5%, 40 keys, 60 paths)

| error of our close estimate | margins price / qty | void rate | best score |
|---|---|---|---|
| 0.02% (live price 10 s before) | 0 / 0 | **27%** | 511 |
| 0.02% | **0.1% / 0.3%** | **0%** | 512 |
| 0.1% (≈ a stale 5-minute reference) | 0.1% / 0.3% | 14% | 509 |
| 0.1% | 0.4% / 1.2% | 1.4% | 504 |
| 0.3% (fast market / several stale sweeps) | 0.4% / 1.2% | 21% | 478 |

Sizing all-in at exactly the estimate voids about a quarter of the trades. The live referee already shows
73 `funds` voids from other players doing that. Use 0.1% / 0.3% normally and widen to 0.4% / 1.2% when the
referee's `age_s` is ≥ 300 or Hyperliquid moves fast. A voided pair only retries next sweep, at a slightly
different entry.

## 5. Recommendation

- **Strategy:** K, a ladder on new extremes with a split start and contrarian favoured pricing.
  - At the opening sweep, one pair favours the long and one favours the short.
  - Afterwards, each time HL's live price is x below the last low used, a new pair favours the long at
    `floor(c/1.01)`. Each time it is x above the last high, a new pair favours the short at `ceil(c/0.99)`.
  - Size with the official funds check at `c·(1±0.3%)` and hold to S.
- **Parameters:** x = 0.25% with 100 keys (median 54 used, p90 92), 0.5% with 40, 1% with 20. Price margin
  0.1%, quantity margin 0.3%, both widened to 0.4% / 1.2% on stale references. `until = n`. 128-bit random ids.
- **Keys:** 100 if key custody is acceptable, otherwise 40. With 2 keys the expected best is 387, with a
  39% capture and ~0.08 places vs a competent field.
- Every sacrificed key ends around −2% plus the move against it. About 60% of the keys we use finish
  negative, by design: only the top key matters.
