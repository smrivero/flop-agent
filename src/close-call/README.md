# Close Call (close-1) — observe / paper / dry-run, 24/7 paper service

`src/close-call/` follows the FLOP Close Call contest and paper-trades Strategy K with fake keys. **This build
cannot write to Technocore.**
- The write machinery (journal, pure protocol-write builders, probe and room planners) is exercised only
  against the in-memory `testing/mock-technocore.ts`.
- The real signer and HTTP transport live in `live/` and are imported by nothing; `guard.test.ts` fails if
  anything outside `live/` or tests reaches them.
- `CLOSECALL_MODE=live` needs `CLOSECALL_LIVE_ENABLED=<exact ack>` too, and even then the CLI refuses
  (exit 3, "NO WRITE").

VPS deployment, monitoring and backups: [`deploy/closecall/DEPLOY.md`](../../deploy/closecall/DEPLOY.md).

It shares nothing with mentions/radar, debate, tclk or sonnet. It has its own SQLite file, its own env
prefix, its own vendored package and its own `closecall:*` scripts. It does not import `src/technocore.ts`
or `src/identity.ts`; only a test uses `identity.ts` to verify real public signatures.

## Commands

```sh
npm run closecall:paper        # service loop (lock, health server, safety checks); also closecall:run
npm run closecall:observe      # referee rooms + Hyperliquid only
npm run closecall:dry-run      # decide the next sweep once, print everything, store nothing
npm run closecall:status       # snapshot (no network)
npm run closecall:health       # the health document (process, sweep, HL, db, disk, halts, keys, pending)
npm run closecall:positions    # last paper positions
npm run closecall:leaderboard  # referee pnl_top vs our best paper keys
npm run closecall:keys         # key inventory; --validate checks keys/ dir 700, files 600, encrypted backups
npm run closecall:pending      # intents / write attempts not final
npm run closecall:report       # estimate errors A/B/C, triggers, voids, fees, look-ahead gap
npm run closecall:reconcile    # L1 + L2 replay through the fold
npm run closecall:backup       # online sqlite backup + integrity_check (--keep N)
npm run closecall:restore-check -- <file>
npm run closecall:unhalt -- --code <code>   # clear a grave halt
npm run closecall:bootstrap-plan            # live limits from /config + agent.json -> 103/104 writes, timing
npm run test:closecall
```

`observe` and `paper` accept `--minutes N`. Everything lives under `CLOSECALL_DATA_DIR` (default
`data/close-call/`, gitignored; `/var/lib/flop-closecall` on the VPS): `close-call.sqlite3`, `logs/`,
`keys/`, `backups/`, `closecall.lock`.

**Logs.**
- Console: `[CLOSECALL][CATEGORY] key=value`.
- JSONL: `logs/events-YYYY-MM-DD[.N].jsonl`, with level, component and redaction of secret-looking fields.
- Rotation: files rotate at 20 MB; old files are pruned after 14 days or once the total passes 500 MB.
- Raw referee posts go to `logs/raw-*.jsonl`.

## Architecture

| file | role |
|---|---|
| `config.ts` | `CLOSECALL_*` env, read once; observe/paper/dry-run only |
| `contest.ts` | vendored `contest.json` + sweep clock (n ↔ boundary time) |
| `decimal.ts` | exact micro-unit (1e-6) BigInt arithmetic, same results as the fold's Decimal |
| `protocol.ts` | referee post parsing (known fields only; unknown ones recorded), canonical terms, signing strings (verified on 64 real trades), 128-bit ids, limits formula |
| `fold.ts` + `fold_bridge.py` | the OFFICIAL `close_call_fold.py`, vendored byte-identical in `vendor/technocore-close-call/`, run in a python3 child. `manifest.json` must hash to the referee's seed `package`, and every file to the manifest, or nothing starts |
| `ledger.ts` | TypeScript mirror of the fold, for synchronous risk checks; differential-tested against the fold |
| `observer.ts` | GET-only reader of the 5 referee rooms: cursors, ring gaps, generation resets, `missed`, `age_s`, stale refs, close/ref changes, 429 backoff |
| `hyperliquid.ts` | read-only `recentTrades` for xyz:NVDA: price, tid, time, age, last trade before a boundary |
| `store.ts` | SQLite (WAL, busy_timeout, `user_version` migrations v1–v3, integrity_check at start, online backup); no private keys |
| `keys.ts` | CC001..CC100 key model (fake DIDs in this build) |
| `estimator.ts` | `estimated_close`: A `ref`, B `hl`, C `combined` |
| `strategy/k-ladder.ts` | Strategy K, pure and swappable (`Strategy` interface) |
| `risk.ts` | pricing, sizing, and every fold check plus stricter policies |
| `paper.ts` | the future pipeline end to end, with fake keys; main book + look-ahead book, both in the official fold |
| `reconcile.ts` | L1 referee consistency; L2 official fold vs mirror |
| `status.ts`, `run.ts`, `cli.ts` | snapshot, single-threaded loop, commands |
| `safety.ts` | safe mode: transient halts (referee/HL stale, disk low) clear themselves; grave ones (reconcile mismatch, db corruption, room ownership, nonce conflict, ambiguous operation) need `unhalt --code`. The observer never stops |
| `stale-policy.ts` | TRADE / REDUCE / HALT_NEW_ENTRIES / adaptive for a stale referee |
| `lock.ts` | single instance: O_EXCL pidfile (liveness + cmdline) + Linux abstract socket |
| `journal.ts` | write journal: intent persisted, nonce reserved and body signed in one transaction **before** the network; read-back before any resend |
| `protocol-writes.ts` | pure builders for signed room messages and signed notes (POST `/kv/<ns>/<key>`) |
| `keys.ts`, `confirmation.ts` | key state machine and mint evidence under STRICT / PROTOCOL / PROBE |
| `room.ts`, `probe.ts` | room state machine + 5-day ownership refresh plan; idempotent probe planner/resolver |
| `limits.ts` | live server limits and the bootstrap plan |
| `alerts.ts` | log + sqlite always; webhook / Telegram optional, deduped |
| `health.ts`, `http.ts` | health document, Prometheus `/metrics`, GET-only server on 127.0.0.1 |
| `keystore.ts` | key dir permission / backup validation (never reads key contents) |
| `testing/mock-technocore.ts` | in-memory server: signatures, per-key nonces, dupe filter, d-room owner/allow gate, faults |
| `live/` | signer + HTTP transport, **not imported anywhere** |

### Why SQLite

`better-sqlite3` is already a dependency, used by mentions, verifier, tclk-marketplace and protocol-watcher.
Cursors and sweep rows update atomically, restarts are safe, and everything can be audited with SQL. Paper
balances are never stored. `paper_sweeps` keeps the trades fed to the fold, and every start replays them
through the official fold and reconciles.

### Reconciliation: what "RECONCILE OK" means today

- **L1 — referee self-consistency.** The five summary posts of each sweep agree with each other and with the
  previous sweep:
  - one file hash across the five posts;
  - `applied` equals the previous close;
  - the limits formula holds;
  - owners delta equals listed + omitted mints;
  - rooms delta equals the new rooms;
  - global is unchanged when nothing settled;
  - `mark` equals global.

  It catches a referee that contradicts itself or a broken parser. It does **not** check anyone's balance.
- **L2 — our books.** The official fold (vendored, byte-identical) and the TypeScript mirror agree exactly on
  cash, fees and lots of every key of ours, after each sweep and on every restart. It proves our
  bookkeeping of our own trades, as we fed them.
- **Not done: full replay.** The flow `file` (the sweep's full input) is referenced only by hash. No public URL
  or endpoint for it is documented:
  - not in the package, the manual, patterns.md or openapi.json;
  - not on the contest design page;
  - a note key cannot even hold a 64-char hash.

  So we **cannot** replay the referee, and we cannot recompute the state `root`. That is a known limitation,
  not an OK.
- **Summary lists are truncated.** Every flow post is at the 4,096-char message cap. Recent sweeps list
  **0 mints** (thousands omitted), and as little as 64 of 1,305 settled trades (sweep 55). Absence from a
  list proves nothing, and presence is the only explicit evidence we can get.

### Lifecycle (enforced in code)

Keys (`keys.ts`, `transitionKey()`, illegal edges throw):

```
UNUSED -> GENERATED -> REGISTER_PENDING -> MINT_EXPECTED -> [PROBE_PENDING ->] MINT_CONFIRMED -> READY -> ACTIVE
(any -> ERROR)
```

`MINT_CONFIRMED` needs evidence the configured policy accepts (`CLOSECALL_CONFIRMATION_POLICY`, default STRICT):

| source | meaning | STRICT | PROTOCOL | PROBE |
|---|---|---|---|---|
| `flow.mints` | our DID listed in a flow post | yes | yes | yes |
| `room-acceptance` | our room listed in `flow.rooms` ⇒ its registering owner (CC001) was an owner | – | yes | yes |
| `protocol` | exact owner text, stamped after REGISTER_CONFIRMED, sweep published, not in `missed`, no `not_owner` void | – | yes | – |
| `probe` | a probe trade of ours settled (see caveat) | – | – | yes |
| `paper-fold` | fake keys only; refused for real ones | paper | paper | paper |

Timing alone is never evidence.

- **Is a room in `flow.rooms` proof of CC001's mint?** It is strong but inferred, not documented.
  - On 25 Sep, 13/13 registrations by keys that were not yet owners stayed unlisted, and 3/3 by owners were
    listed, one of them in the same sweep as the owner message.
  - Evidence: `research/close-call/results/live/room_registration_evidence.txt`.
- **STRICT may never confirm a key.** Recent flow posts list 0 mints, because the list is cut at the
  4,096-char cap.

**Probe (`probe.ts`).**
- Quantity 0.10. The id is persisted before sending and the same id is reposted until `until`. After
  `until`, a repost is only a query: settled or expired.
- A new id is issued only after the old one resolves, with the direction reversed.
- Cases A–H are tested through the official fold.
- **Not fully safe (case D).** `void:settled`, or the id listed as settled, can be an adversary replaying our
  signed message. That proves the *id* settled, not that our keys did. Probes exposed while unsettled are
  rejected as evidence.

**Stale referee (`stale-policy.ts`).**
- Adaptive: TRADE normally; REDUCE (wide margins) at age ≥ 60 s; HALT_NEW_ENTRIES at age ≥ 300 s, delay
  ≥ 45 min, or divergence ≥ 50 bps.
- In 1,440 seasons through the fold, HALT_NEW_ENTRIES beats REDUCE by +4.6 / +5.1 mean max at 40 / 100 keys
  (+44 / +46 on the ~10% of paths where it matters). TRADE ≈ REDUCE.
- Source: `research/close-call/results/stale_policy_summary.json`.

Room (`room.ts`, `transitionRoom()`):

```
UNCREATED -> CLAIMED -> ALLOWLIST_PENDING -> REGISTER_PENDING -> REGISTER_CONFIRMED -> READY   (any -> ERROR)
```

| step | evidence |
|---|---|
| CLAIMED | `room-owners` read back equals our DID |
| ALLOWLIST_PENDING | allow-list write sent |
| REGISTER_PENDING | `room-allow` read back holds every DID, and our room message was posted |
| REGISTER_CONFIRMED | the room is listed in `flow.rooms` |
| READY | the owner key is MINT_CONFIRMED |

### Known pre-existing failures elsewhere (not Close Call)

`npm test` reports 7 failures in `src/sonnet/` (propose.test.ts, run.test.ts). They fail identically on a
clean checkout of HEAD, because they validate against the real clock and the Sonnet contest deadline has
passed ("contest deadline has passed"). They are left as they are.

## Room for 100 keys: owned `d-` room

Verified in the current docs (`llms.txt`, `patterns.md`, `openapi.json`) and in the server source
(technocore-chat `0e47f77`; the live server reports 0.14.5).

- **Claim.** `GET /kv/room-owners/d-<room>/set-signed/<did>/<sig>/<nonce>/<same did>?if_absent=1`, signature
  over `room-owners|d-<room>|<nonce>|<did>`.
  - It must be signed by the key it stores.
  - It must happen before the room's first message: the server refuses a claim once `last_seq > 0`.
- **Allow-list.** One note, `/kv/room-allow/d-<room>`, value = DIDs separated by spaces, signed by the owner
  over `room-allow|d-<room>|<nonce>|<value>`.
  - All 99 extra DIDs go in **one write**, not 99.
  - 99 × 56 + 98 = 5,642 chars, under the 8,192 note cap (~143 DIDs max).
  - We write it with `POST /kv/room-allow/d-<room>` `{"value","did","sig","nonce","if_absent"}`
    (`buildSignedNote`).
  - The 99-DID round trip (sign → POST → read-back → gate admits all 99, refuses others) is tested against the
    mock server.
  - Changing the list means rewriting the whole value.
- **room-nonce.** `/kv/room-nonce/d-<room>` is written by the server. It is one counter shared by every
  signed ownership write for that room, and each claim/allow-list write needs a nonce greater than it.
- **Message nonces** are separate: per key, per room, strictly increasing (a millisecond clock works).
- **Expiry.**
  - Rooms and notes are deleted after 7 days without a write.
  - The source keeps the three guard notes (owners, allow, nonce) alive as long as **the room itself** was
    written in the last 7 days. So what must be refreshed is room activity: our 99 registrations and our
    trades, plus a keep-alive message if the room goes quiet for ~5 days.
  - The contest package (written against an older server revision) says the referee rewrites its own claims
    weekly. We do not rely on room activity:
    - `planOwnershipRefresh()` re-signs the claim and the allow-list every `CLOSECALL_ROOM_REFRESH_DAYS`
      (default 5), 2 writes.
    - It first reads both notes back. It refreshes only if the owner is still ours and the allow-list is
      exactly ours; any other content is a grave `room_ownership` halt and is never overwritten.
    - Tested against the mock server; not executed.
  - A room that loses its owner note while holding messages can never be claimed again.

Alternatives: `mb-` accepts any signed key, so outsiders could flood it. `close1` is flooded: the referee
`missed` 2,146+ of its messages.

## Bootstrap, recalculated

| # | write | count |
|---|---|---|
| 1 | claim `d-<room>` (CC001) | 1 |
| 2 | allow-list CC002..CC100, one note | 1 |
| 3 | `owner` CC001 in `close1` | 1 |
| 4 | `room` registration in `close1` (by CC001, **after** CC001 is MINT_CONFIRMED) | 1 |
| 5 | `owner` CC002..CC100 in our room (**after** REGISTER_CONFIRMED) | 99 |
| | **total without test trade** | **103** |
| 6 | test trade (after mints) | 1 → **104** |

Plus 2 writes per ownership refresh (every 5 days) and optional probes.

- **Rate limit is read live**, never hardcoded: `npm run closecall:bootstrap-plan` reads `/config` and
  `/.well-known/agent.json`.
  - Today (v0.14.5): 300 writes/min/IP, shared with the other bots on the server, and 20 new rooms/day/IP.
  - At that rate, 104 writes take 21 s of pure send time.
- **Elapsed time is dominated by the referee.** The bootstrap needs 3 sweep boundaries: CC001 owner + room →
  other owners → test trade.
  - About 15 min with a punctual referee.
  - About 2 h 20 min (141 min) with the 42-min lag seen on 25 Sep.
  - About 2 h 50 min (170 min) as the prudent plan, which adds one missed sweep.
- **Mints confirmed: not guaranteed in any number of sweeps.** Recent flow posts list 0 mints, so under the
  "explicit evidence only" rule CC001 could stay REGISTER_PENDING indefinitely, and step 4 would never
  start.
  - PROTOCOL confirms in about 2 published sweeps.
  - PROBE adds 1–2 more.
  - Choosing a policy is the operator's decision.

## Plan to production

Done: paper service hardening (lock, journal, safe mode, health, alerts, logs, backups), the systemd unit, and
the deploy/install/backup scripts, none of them executed.

Still to do:

1. Deploy paper to the VPS (`deploy/closecall/DEPLOY.md`) and run ≥ 24 h. Watch halts, error bps, voids,
   L1/L2 and memory.
2. Choose the mint confirmation policy (STRICT / PROTOCOL / PROBE).
3. Separately reviewed: wire `live/` into the CLI behind the double switch, generate real keys offline, and
   set up the encrypted key backup **before** the first key exists.
4. Run the bootstrap one step at a time, with the user's go-ahead for each step.
