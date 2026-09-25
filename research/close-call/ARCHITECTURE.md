# Proposed module: `src/close-call/` (NOT implemented)

Lives inside `flop-agent` next to mentions/radar, debate, tclk and sonnet. It imports only generic helpers
(`src/technocore.ts` HTTP client, the did:key signing in `src/identity.ts`) and changes none of them. It has
its own env prefix `CLOSECALL_`, its own SQLite file and its own systemd unit.

## Design rules (from the Sonnet post-mortem)

1. **The referee's posts are the only truth.** A key is `minted` only when a flow post (or its archived file)
   lists it. A trade is `settled` only when a flow post lists its id; `void` with the posted reason. Our POST
   returning 200 is only `submitted`.
2. **Our state is a replay.** Positions, cash and scores are recomputed by running the OFFICIAL fold
   (`close_call_fold.py`, pinned by hash) over the referee's flow data for our keys, and compared with
   `d-close1-positions`/`pnl`. Any mismatch stops execution.
3. **One bad item never stops a tick.** Every key and every order is processed and persisted on its own, and
   errors are logged per item.
4. **Idempotent and restartable.** Every intent has a deterministic id stored before it is sent, so a restart
   never double-trades.
5. **Dry-run is explicit.** `CLOSECALL_MODE=observe|paper|live`, default `observe`. The deployment checklist
   prints the value and refuses `live` without a key inventory check.

## Components

```
src/close-call/
  protocol/     message shapes, JSON canonicalisation (sorted keys, no spaces), terms/accept signing
                strings, trade-id generation (128-bit random), sweep-number <-> time, limits math
  observer/     long-polls d-close1-price|flow|positions|pnl|state (?wait=) + Hyperliquid recentTrades;
                parses documented AND live fields (applied, for, age_s, omitted, missed); stores raw posts
  fold/         runs the pinned python fold (child process) or a TS port that must match it on the
                sample season + our own vectors in CI; replays our keys from flow data
  state/        per-key ledger (see below), per-intent lifecycle, reconciliation vs referee posts
  strategy/     pure functions: (market snapshot, key ledger) -> intents. Ladder-of-extremes, pricing modes.
                No I/O, fully unit-tested against the fold
  risk/         gates every intent: funds margin, limits, stale-reference guard (age_s), max keys per sweep,
                "no all-in without exit reserve" for rebalancing keys, kill switch
  execution/    turns intents into signed terms + accept, posts the trade message in OUR registered room,
                handles nonce per (key, room), retries only on a new sweep with new pricing, sets until = n
  keys/         key inventory: loads DIDs from files, never prints secrets, checks file modes 600,
                registration + room-registration flows
  storage/      SQLite `.data/close-call.sqlite3`: keys, intents, trades, referee_posts, marks
  cli/          observe | status | plan (dry) | register (live) | run; `flop-status.sh` section
```

## Key ledger (one row per key, all derived from referee data except the first three fields)

| field | source |
|---|---|
| `did`, `key_path`, `label/role` | inventory (role: favoured-long, favoured-short, sacrificial, reserve) |
| `registration_status` | submitted → seen-in-room → **minted** (flow `mints` / archived file) |
| `mint_status`, `minted_at_sweep` | flow |
| `cash`, `lots` (FIFO), `position`, `fees` | fold replay of settled trades |
| `trades` | intents → submitted → settled/void(reason) from flow |
| `score_at_mark`, `score_if_S` | fold `value_at(mark)` and at scenarios |
| `status` | idle / armed / in-position / stuck (all-in, cannot exit) / error |

## Execution details that must be right

- **Room.** Register one low-traffic room owned by us (a `d-` room with an allow-list of our keys, or an
  `mb-` mailbox). Register every key and post every trade there, never in `close1`: the referee already
  missed 2,146 `close1` messages. Keep it alive with at least one message per few days (7-day idle reaper).
- **Rate limits (per IP):** 300 writes/min, 600 reads/min, 20 new rooms/day, max 5 copies of one text in
  120 s. A 100-key registration is ~100 writes; spread them over two minutes.
- **Timing.** Post the trade ~20–40 s before the sweep boundary with `until = n`. If it lands late it
  expires instead of settling at an unknown price.
- **Pricing.** `favor_long: floor(c_est/1.01/(1+0.1%))`, `favor_short: ceil(c_est/0.99·(1+0.1%))`, both
  clamped to the posted `limits`. Size with the official funds formula at `c_est·(1±0.3%)`.
- **Stale reference guard.** If HL's last trade is > 60 s old, or the referee's last `age_s` ≥ 300, skip the
  sweep: the fee close may be stale.
- **Nonces.** Strictly increasing per (key, room): use `time_ns`-based nonces, persisted.

## Managing 20–100 keys without bugs

- Keys are data, not code paths. Every loop is `for key in inventory`, and each key's state machine is the
  same, tested once with parameterised tests over 1, 2, 20 and 100 keys.
- A pre-flight command prints, for every key: DID, file present and mode 600, minted?, room allowed?, nonce
  high-water mark. Nothing is sent while any key is red.
- Paper mode runs the full loop against live referee data with fake keys, and the fold replay must agree
  with the plan before `live` is allowed.
- The status report per key comes from referee data (minted/settled/void), not from our own logs.
