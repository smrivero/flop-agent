# Close Call (close-1) — observe / paper / dry-run, 24/7 paper service

`src/close-call/` follows the FLOP Close Call contest and paper-trades Strategy K with fake keys. The live
writer is **implemented but not connected: this build cannot write to Technocore.**
- Implemented: key generation, signing, nonces, room claim, allow-list, owner and room registration, maker
  and taker signatures, trade publishing, the persistent write journal, and idempotent retry/recovery
  (`bootstrap.ts`, `journal.ts`, `protocol-writes.ts`, `live/`).
- It runs only against the in-memory `testing/mock-technocore.ts`, in tests and `closecall:bootstrap-dry-run`.
- `live/cli-live.ts` refuses the real bootstrap while `LIVE_WRITER_CONNECTED = false` (exit 3, "NO WRITE").
  Flipping it is the reviewed go-live change, and it still needs `CLOSECALL_MODE=live` plus the exact
  `CLOSECALL_LIVE_ENABLED` ack plus the backup gate.
- Paper mode cannot reach any of it: `cli.ts`, `run.ts` and `paper.ts` never import `live/`, and
  `guard.test.ts` fails if any runtime file does.

**Keys.** Close Call uses its own new keys CC001..CC100.
- Any did:key may register once, any time until the lock, and each owner gets 10,000 POLF.
- The project's A/B identities are **not** used for Close Call and are **not** a limitation here. That
  restriction belonged to the Sonnet challenge.

VPS deployment, monitoring and backups: [`deploy/closecall/DEPLOY.md`](../../deploy/closecall/DEPLOY.md).

It shares nothing with mentions/radar, debate, tclk or sonnet. It has its own SQLite file, its own env
prefix, its own vendored package and its own `closecall:*` scripts. It does not import `src/technocore.ts`
or `src/identity.ts` from runtime code; only `live/`, `testing/` and tests use `identity.ts` (did:key
encoding, verification and, in `live/keygen.ts`, generation).

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

`MINT_CONFIRMED` needs evidence the configured policy accepts (`CLOSECALL_CONFIRMATION_POLICY`). The default is **PROTOCOL**, the operator's choice for live; STRICT and
PROBE stay available for diagnosis and fallback:

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

## Live preparation (implemented, not connected)

**Backup gate (`backup-gate.ts`).** No real key is generated, and no live write happens, until an
age-encrypted backup of exactly the current key files has been decrypted and checked on the operator's Mac.
The VPS knows only the age **public** key.

1. `closecall-backup.sh`:
   - creates `keys/BACKUP-CANARY` once;
   - runs `tar(keys/, env) | age -r <recipient>` into `secrets-<ts>.tar.age`;
   - records `secrets-<ts>.manifest.json` with the archive sha256, every key file's sha256 and the
     canary's sha256.
2. Mac: `LOCAL=1 AGE_IDENTITY=… closecall-restore-check.sh secrets-….tar.age`
   - decrypts into a private temp dir;
   - reloads and self-tests every key (seed → did, sign → verify);
   - prints a **VERIFY CODE** (canary + digest of the key-file set);
   - deletes the decrypted copy.
3. VPS: `flop-closecall keys --backup-verify --archive … --code …`.
   - Only someone who decrypted the archive knows the canary.
   - The gate stays open only while the archive is unchanged and the key files on disk are **exactly** the
     verified set. New keys close the gate until they are backed up and verified too.

**Key generation (`live/keygen.ts`, `flop-closecall live keygen --total N --i-understand-these-are-real-keys`).**
- It generates only the missing ids up to N.
- Each key is a `{did, seedHex}` file created with O_EXCL (never overwritten), 0600 in a 0700 dir, fsynced,
  then reloaded and self-tested.
- The live DB (`live.sqlite3`, separate from the paper DB) stores did + path only.
- It refuses a paper DB and refuses without the gate.

**Bootstrap (`bootstrap.ts`).**
- It runs one idempotent `step()` at a time, re-deriving its position from the DB and the server.
- Every write goes through the journal: persisted and signed before the network, read back before any
  resend. An UNKNOWN write is resolved by read-back on the spot, and anything still ambiguous halts.

| # | step | evidence to move on |
|---|---|---|
| 1 | claim `room-owners/<room>` = CC001 (if_absent; only while the room is empty) | note reads back = CC001 |
| 2 | allow-list = CC002..CCN (one note; grows when keys are added) | note reads back exactly; a foreign DID halts |
| 3 | CC001 `owner` in close1 | message located (seq, ts) |
| 4 | CC001 MINT_CONFIRMED | PROTOCOL: stamped sweep published, not in `missed` (a missed message is reposted, max 3) |
| 5 | `room` of our room in close1, by CC001 | message located |
| 6 | room in `flow.rooms` | REGISTER_CONFIRMED → READY |
| 7 | CC002..CCN `owner` in **our** room, paced to `CLOSECALL_WRITE_BUDGET_FRACTION` of the live write limit | each located |
| 8 | each key MINT_CONFIRMED → READY | PROTOCOL evidence |
| 9 | test trade 0.10 CC001→CC002 (taker named, both signatures) in our room | settled in flow; void/expired/ambiguous halt for a manual look |

After that, every `CLOSECALL_ROOM_REFRESH_DAYS` it re-signs both notes with their current values. Before
doing so it reads them, and any foreign value halts.

**Dry-run.** `npm run closecall:bootstrap-dry-run` (or `flop-closecall live bootstrap --dry-run --faults --miss-first`)
runs the real state machine, journal and signing code against the in-memory server and a simulated referee
that follows the published rules. It uses throwaway in-memory keys; mints are never listed, as seen live.
- Measured: 2 keys = 6 POSTs; 2 → 100 keys = 99 more (one allow rewrite + 98 owners).
- With faults (lost requests, timeouts after commit, a crash after planning, CC001's message missed by the
  referee): no duplicate, every write CONFIRMED, test trade settled once.
- Under STRICT with unlisted mints, CC001 waits indefinitely and nothing else is written.

## Live execution (implemented, NOT connected)

```
                 decision engine (paper.ts: estimate -> Strategy K -> pair, side, px, qty, until -> risk + official fold)
                                   | the SAME intent
                 +-----------------+------------------+
          PaperExecutor (simulates)          LiveExecutor (live/executor.ts)
```

**The LiveExecutor never decides.** It takes the intent unchanged and does the following:
1. persists `live_trades` CREATED (trade id and payload hash fixed forever);
2. checks keys READY/ACTIVE, room READY, the maker in the room's writers;
3. runs `precheck()`, the engine's own re-validation right now:
   - not halted, still before the deadline, same reference;
   - stale policy is not HALT;
   - limits, balances, collateral, fees and key states on the current book, including our trades already
     posted this sweep;
4. signs maker and taker **once**, verifies both, and freezes the text (SIGNED);
5. POSTs once through the write journal (outer nonce persisted per DID and room);
6. records POSTED, FAILED or UNKNOWN, with timings: decide → sign → post → response → stamp.

After that:
- `confirmPosted()` locates the message: CONFIRMED if it was stamped before the boundary, LATE otherwise.
- The fold then gives SETTLED or VOID.
- `verifyWithReferee()` compares against the referee's lists. Settled vs void in either direction is a grave
  halt; an id missing from the truncated lists is "unlisted".

**Intents and strategy state are persisted before any POST.**

**Recovery after a crash:**

| state at the crash | on restart |
|---|---|
| no `live_trades` row, or CREATED/SIGNED | executed if still before the deadline, same trade id and same signed text; otherwise NOT_POSTED and the pair is released |
| POSTING, journal PREPARED | sent if before the deadline |
| POSTING, journal SENDING/UNKNOWN | read-back **only**: found → POSTED; not found → UNKNOWN + grave halt, never re-sent |
| POSTED onwards | nothing to do |

**Gates.** `live run` refuses unless `live-check` passes:
- CLOSECALL_MODE=live plus the ack;
- LIVE_WRITER_CONNECTED;
- a separate DB and lock;
- READY keys with key files self-tested;
- the backup gate: an age archive plus the Mac restore verification of exactly these key files;
- the room READY, the bootstrap done, a valid policy;
- sane nonces;
- fresh referee and Hyperliquid data;
- not halted;
- no pending writes and no UNKNOWN trades.

**Paper vs live, what still differs:**
- Keys: the fake CC001..CCnnn, versus real READY keys minus those used by the bootstrap test trade. They
  hold a 0.10 position, so the pair numbering shifts.
- Mint in our book: the paper keys mint at the first sweep; the live keys enter the book at the first sweep
  after the service starts.
- Truth: the paper book is the fold. The live book is also the fold, but it is checked against the referee's
  lists, which are truncated, so many ids stay "unlisted".
- An UNKNOWN POST halts live execution for an operator decision; paper never has one.

## Operational design for live (pre-live audit, 26 Sep)

**Isolation.**

| | PAPER | LIVE |
|---|---|---|
| data dir | `/var/lib/flop-closecall` | `/var/lib/flop-closecall-live` |
| DB | `close-call.sqlite3` (fake keys, paper strategy state, paper halts and mismatches) | `live.sqlite3` (fresh: its own keys, strategy state, intents, nonces, journal, halts) |
| lock, logs, backups, health port | inside the paper dir, 8787 | inside the live dir, 8788 |
| env | `closecall.env` | `closecall-live.env` |

- Each unit has `InaccessiblePaths=` on the other tree, so neither service can read or write the other's
  state.
- `live-check` fails if live points at the paper dir.
- Live starts with an empty strategy state. Its first decision is the split start at the market price of that
  moment:
  - `lo = hi = estimate`, with pairs 0 and 1;
  - the next low is `lo × (1 − 0.25%)` and the next high is `hi × (1 + 0.25%)`;
  - pairs are used in order.
- Nothing is inherited from paper: not lo/hi, not pairs_used, not the trigger history.

**Key roles.**
- `CC-ADMIN` claims, owns and registers the room, refreshes the notes and posts keepalives. It never trades.
- `CC-TEST-001/002` make the 0.10 staging trade.
- `CC001..CC100` are the strategy keys, untouched until Strategy K uses them: 10,000 POLF, flat.

This fits the rules: any did:key may register once, any owner may register a room, and one operator may run
many keys. The admin must itself be an owner, because only owners register rooms; its 10,000 POLF stay idle.

**Commands.** All are resumable and idempotent:
```
flop-closecall live keygen --role admin|staging|strategy --total N --i-understand-these-are-real-keys
flop-closecall live bootstrap --loop
```

Per-key flags, in `flop-closecall --live keys`:
```
GENERATED → BACKED_UP → REGISTERED → MINT_EXPECTED → MINTED → ROOM_ALLOWED → READY
```

**Writes, retries and rate limits.** Limits are read live from `/config`: today 300 writes/min/IP, and the
bootstrap uses 25% of that.

| write | on 429 | on timeout / crash |
|---|---|---|
| bootstrap: claim, allow (CAS `if`), owner, room, staging trade | not stored → same signed body after `Retry-After`, up to 6 times, then halt | read-back first; resend the same body only if absent (the nonce guard prevents a duplicate) |
| strategy trade | same body, only while it can still land before `boundary − 3 s`, else NOT_POSTED | read-back **only** → found: POSTED; absent: UNKNOWN + grave halt, never re-sent |

**PROTOCOL mint evidence.** Timing is never evidence. All of the following are required:
- our owner message, byte-exact and signed, in a room registered before its stamp (`close1`, or our room after
  the sweep that listed it);
- stamped for a sweep the referee has **published** (flow and state posts);
- outside every `missed` range;
- the state post's owner count grew by **at least as many as our registrations stamped for that sweep**;
- no `not_owner` void of ours.

`flow.mints` is never needed, so truncation does not matter. The first trade of each key is a further check: a
`not_owner` void is a grave mismatch.

**Trade finalization.** The official fold is fed ONLY trades the referee demonstrably read:

| state | evidence |
|---|---|
| POSTED | 2xx, or found by read-back (`from` = our DID, exact text incl. trade id and both sigs, our nonce) |
| CONFIRMED | located in our room, server `ts` ≤ the sweep boundary |
| SETTLED / VOID | the official fold at the referee's own published ref/close, only after that sweep's flow post is published and the trade's seq is outside every `missed` range |
| NOT_APPLIED | stamped after the boundary, or inside a missed range: kept out of our book, pair released for a retry |
| UNKNOWN | POST uncertain and not found: grave halt, no new entries, operator decides |

- The referee's lists then **verify**: listed settled vs fold void, or the reverse, is a grave halt.
- An id the lists do not mention is `unlisted`. Truncation is normal, it never blocks, and the fold's outcome
  stands. The fold is deterministic on those inputs and our trades only touch our own accounts.

**Room lifecycle.** technocore deletes rooms and notes with no write for 7 days, and a room still on a single
message after 12 h. Every minute, `RoomKeeper`:
- checks that the owner note is CC-ADMIN, the allow-list is exactly ours and the room still exists; otherwise a
  grave halt, and it **never** re-claims or recreates anything;
- re-signs both notes with their current values every 5 days;
- posts a plain-text keepalive after 48 h idle.

**Allow-list.** 102 DIDs take 5,813 characters, against a real limit of 8,192 per note value on
`POST /kv` (openapi): about 143 DIDs fit.

**Startup order (live run).**
1. The readiness gate, against the server:
   - keys, room owner and allow-list;
   - nonce reconciliation: our journal must not be behind the server;
   - clock/NTP, backup and permissions.
2. Bootstrap-era writes reconciled.
3. Observer, then L1.
4. Fold replay.
5. `live_trades` recovery.
6. Decisions, none while any halt (e.g. an UNKNOWN trade) is active.

**Backup = full state.** The age archive holds the key files, the canary, the live env and a consistent
`live.sqlite3` snapshot: live_trades, nonces, journal, strategy state, room state, halts. The Mac restore-check
also runs a **drill**: it rebuilds the live dir from the archive in a temp dir and runs
`live-check --offline` on it.

## Plan to production

Done:
- paper service on the VPS;
- live writer implemented and tested offline, **not connected**.

Gate to live:

1. 24 h paper on the VPS, clean on uptime, gaps, reconcile, estimated_close, stale data, triggers,
   settled/void, memory and SQLite/log growth.
2. age key pair on the Mac, recipient in the env, then backup → Mac restore-check → `keys --backup-verify`.
3. Reviewed go-live change (`LIVE_WRITER_CONNECTED = true`), `CLOSECALL_ROOM` chosen, `CLOSECALL_MODE=live`
   plus the ack.
4. **2 real keys** → backup + verify → bootstrap until the 0.10 test trade settles → validate against the
   referee.
5. Keys up to **100** → backup + verify → bootstrap (allow-list rewrite + 98 owners) → mints.
6. Only then, Strategy K on real keys.
