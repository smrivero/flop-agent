# close-1 live state (read-only snapshot)

Fetched with plain GETs `https://technocore.chat/r/<room>?format=json&limit=500` at **2026-09-25 13:54 UTC**
(sweep 22 of 2556, ~1h50m after opening). Raw files: `results/live/d-close1-*.json`. Parsed summary:
`results/live/live_summary.txt`. Nothing was posted, signed or registered.

## Headline numbers

| | value |
|---|---|
| current sweep | 22 (next limits are `for: 23`) |
| seed | 226.14 (HL tid 626256716983248, 11:59:42.666 UTC), package hash = our manifest ✓ |
| reference (close of sweep 22) | 225.03 (13:49:57.723 UTC), age 2 s |
| limits for sweep 23 | 213.78 – 236.28 |
| global price (VWAP of our game) | 224.92 |
| **owners** | **235,095** (0 → 370 → 1,911 → 13,032 → 64,652 → 145,059 → 235,095) |
| keys with a position | **1,445** = 560 longs + 885 shorts (0.6% of owners) |
| open interest | 23,596.06 contracts |
| trades settled (sweeps 1–22) | 919 (893 listed + 26 `omitted`) |
| trades void | 335 (93 listed + 242 omitted). Listed reasons: funds 73, settled 16, expired 3, limits 1 |
| registered trading rooms | 35 (e.g. `flop-bracket-desk`, `nvda-desk-966e`, 7 `mb-p-…` mailboxes) |
| pnl #1 / #2 / #3 at mark 224.92 | **71.87 / 63.91 / 63.91** |
| pnl top list | 25 entries: 1 at 71.87, **24 tied at 63.91** |
| most common \|position\| in the top list | 44.35, 44.22, 44.12 (all ≈ 10000 / c: full 1x at sweeps 1–3) |

## How to read it

- **owners ≠ traders.** Only 1,445 keys hold anything; about 233,650 minted keys have never traded. Every
  minted key is still ranked, at score 0.
- The active population is dominated by **pairs**: open interest ≈ 23,596 ≈ (560+885)/2 × 32.6 average size,
  and the top positions come in ±44.35 pairs. The short count exceeding the long count means some keys sell
  to several buyers (farms using one short against many longs, or partial fills).
- **The top of the board is already one big tie.** 24 keys at exactly 63.91 = the same all-in entry at the
  same sweep. The field is doing what our analysis says, at scale: our max score must beat identical copies.
  Only a strictly better entry breaks the tie.
- Voids are mostly `funds` (people sizing all-in without a margin for the close) and `settled` (reused ids).

## Fields that are not in the documentation

| message | extra fields | meaning (verified on 22/22 sweeps) |
|---|---|---|
| seed | `for`, `limits` | limits for sweep 1 around the seed |
| price | `applied`, `for`, `age_s` | `applied` = previous `ref.px` (this sweep's limits basis); `limits` are for sweep `for` = n+1; `age_s` = age of the HL trade used |
| flow | `omitted` | counts beyond the ~64-entry lists (`mints`, `settled`, `void`) |

## Incidents already visible

- **Missed messages:** flow sweep 22 has `missed: [["close1", 188639, 190784]]`, i.e. 2,146 `close1`
  messages the referee could not read. The room is flooded (>190k messages in 2h) and its history window
  rotates faster than the referee reads it. Registrations or trades posted there can be lost.
- **Stale references:** `age_s` = 300 (sweep 14), 600 (sweep 15), 300 (sweep 20): the referee reused a
  5–10 minute old Hyperliquid trade. That stale price is also the fee close for those sweeps.
- **Id collisions:** 16 listed voids with reason `settled`.
