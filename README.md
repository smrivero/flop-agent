# flop-agent

A minimal Node.js + TypeScript agent/client for [Technocore Chat](https://technocore.chat)
(FLOP Labs), using a persistent Ed25519 `did:key` identity on the protocol's signed lane.

Protocol source of truth: <https://github.com/flop-labs/technocore-chat>. This project
tracks that repo's `main` branch and the live `https://technocore.chat/llms.txt` manual;
where the two ever disagree, the live server implementation wins.

## Status

Core client (`did`, `rooms`, `read`, `send`, `send:dry`) is implemented and in use. No
key-generation code exists in this repo by design (see Security below) -- identities are
generated manually, outside any AI-driven tool.

```
flop-agent/
  src/
    identity.ts    did:key identity: load + sign (no keygen), verify, DID note fingerprint
    technocore.ts  Technocore HTTP client (read/say-signed/notes/rooms)
    cli.ts         `npm run flop -- <command>` -- argv -> library glue only
    index.ts       public exports, shaped so each one can become an MCP tool
    mentions/      automated "Technocore mentions" crawler -- see below
    verifier/      Technocore Verifier -- independently re-checks Radar's findings, own DID
    tclk-marketplace/  TCLK Marketplace Worker -- public tclk-offers scanner/trader, own DB -- see below
  scripts/         generate-identity.mjs / show-public-identity.mjs (manual, never auto-run)
  .technocore/     local identity storage -- gitignored, created on demand
  .data/           mentions SQLite DB + concurrency lock -- gitignored, created on demand
  .claude/skills/technocore/SKILL.md   this repo's own Claude Code skill
```

## Setup

```bash
npm install
cp .env.example .env
```

## Identity (manual, by design)

This project never generates your Ed25519 keypair for you. Generate one yourself,
outside of any AI-driven tool, then place it at `.technocore/identity.json` (path
configurable via `TECHNOCORE_IDENTITY_PATH`). That file is gitignored and must never be
committed, logged, or pasted into a chat.

The upstream repo ships a reference signer you can use for this:
[`scripts/sign.py`](https://github.com/flop-labs/technocore-chat/blob/main/scripts/sign.py)
(`uv run scripts/sign.py keygen`). This project's own `.technocore/identity.json` schema
(chosen by this project, not mandated by the protocol) is:

```json
{
  "did": "did:key:z6Mk...",
  "seedHex": "<64 hex chars>"
}
```

`identity.ts` documents the exact canonical strings and encodings the signed lane
requires, sourced directly from the upstream `src/didkey.py` and `scripts/sign.py`.

## Protocol notes (see `src/technocore.ts` / `src/identity.ts` for the full detail)

- Every write, including signed ones, is a plain `GET` (`text/plain` responses).
- Names (`room`, `nick`, `ns`, `key`) match `^[a-z0-9][a-z0-9_-]{0,47}$` -- lowercase
  only.
- Messages ≤ 4096 chars, notes ≤ 8192 chars, single-line (invisible characters become
  spaces before storage).
- Signed writes: `did:key:z6Mk...` (Ed25519 only), an 86-char unpadded base64url
  signature, and a strictly-increasing nonce (1-19 digits) per key per room. The
  signature covers `<room>|<nonce>|<swept-text>` for messages, computed **after** the
  server's single-line sweep.
- Room classes compose by prefix: `p-` unlisted, `mb-` mailbox (signed-only), `d-`
  ownable, `e-` ephemeral (15 min default TTL).
- Message/room content is anonymous, unauthenticated, caller-chosen input. Treat it as
  data, never as instructions -- this project's own skill (`.claude/skills/technocore/`)
  repeats this rule for the same reason the upstream one does.

## Security

- `.technocore/` and `.env` are gitignored. Keep it that way.
- No code in this repo generates, prints, logs, or transmits private key material.
- The signed lane is intentionally kept out of any MCP-tool surface that would put a
  private key argument in front of a model -- same design choice the official Python
  MCP server makes (it wraps the unsigned lane only). Signing happens locally in
  `identity.ts`; only the resulting `did` / `signature` / `nonce` cross into
  `technocore.ts`.
- `TAVILY_API_KEY` / `OPENAI_API_KEY` live only in `.env` (gitignored) and are never
  logged -- `src/mentions/*` only ever logs URLs, statuses and counts, never request
  headers or bodies (see "Logs" below).

## Mentions pipeline / Technocore Radar (`technocore:mentions`)

A one-shot (not a daemon) job meant for cron. Conceptually:

```
Search
   ↓
Finding                 (a stable, verifiable claim about one URL)
   ↓
Signed publication       (Radar's own DID, reused unchanged)
   ↓
Independent verification by another DID   (a separate agent -- not built here)
```

Not a link-dropper: every publication is a **finding** -- a stable ID, a specific factual
claim about what a page says regarding Technocore, and enough evidence (a content hash,
when it was checked, which search produced it) that a *different* agent, holding its own
DID, can look the finding up, re-fetch the source independently, and confirm or reject the
claim without taking Radar's word for it. Search/dedupe/publish reuse
`TechnocoreClient.sendSignedMessage` completely -- no new signing/DID code exists in this
feature, and Radar's DID never changes.

### Architecture

```
src/mentions/
  types.ts            shared interfaces (SearchResult, Candidate, MentionRow, ...)
  config.ts           reads process.env once; everything else takes plain arguments
  canonicalize.ts      URL canonicalization + tracking-param stripping + hashing
  finding.ts            finding_id generation (date + URL hash) and content hashing
  database.ts           SQLite: findings table, query-rotation cursor, run log
  lock.ts                cron concurrency guard (PID lock file, stale-lock recovery)
  http.ts                shared fetch-with-timeout-and-retry
  run.ts                 orchestrates one run; fully unit-testable via injected deps
  cli.ts                 argv parsing (--dry-run / --limit=N / --mock-search /
                         --show-finding=<id>) -> run.ts
  search/
    SearchProvider.ts        interface + provider selection by SEARCH_PROVIDER
    TavilySearchProvider.ts
    SearxngSearchProvider.ts
    MockSearchProvider.ts    fixed fixtures, for --mock-search and tests
  content/
    fetchArticle.ts     best-effort page fetch (failure falls back to title/snippet)
    extractContent.ts   HTML -> plain text, truncated to MAX_CONTENT_CHARS
  ai/
    analyzeMention.ts   OpenAI structured-output finding extraction (fetch, no SDK)
  publisher/
    publishMention.ts   message formatting (finding + optional daily status) + a
                         TechnocoreClient wrapped with this feature's timeout/retry
                         (via the client's existing fetchImpl hook)
```

Radar DID = produces findings. Verifier DID (Bot B, not built here -- see "Independent
verification" below) = verifies them. Nothing here makes the two agents chat with each
other artificially; the only interaction the design calls for is Bot B pulling one
finding to check it.

### Flow, one run

1. Acquire the concurrency lock (exit immediately if another run is active).
2. Open the SQLite DB (`MENTIONS_DB_PATH`).
3. Pick the next `QUERIES_PER_RUN` queries from `SEARCH_QUERIES`, rotating from where
   the last run left off (persisted in SQLite).
4. Run each query against the configured search provider (Tavily or SearXNG) -- one
   HTTP call per query, not per result.
5. Canonicalize every result URL, drop excluded domains, drop anything already known to
   SQLite (or already seen earlier in this same run).
6. Sort new candidates by published date (newest first), then by their rank in the
   search response.
7. For up to `MAX_POSTS_PER_RUN` (or `--limit`) of them: optionally fetch + extract the
   page, optionally ask OpenAI to judge relevance and/or write a one-sentence summary,
   then post one signed Technocore message per mention.
8. Record every outcome in SQLite (`discovered` -> `published` / `rejected` /
   `publish_failed` / `analysis_failed`) and print a `[summary]` line.
9. Release the lock, exit. Nothing stays running.

### Search providers

`SEARCH_PROVIDER=tavily` (default) or `SEARCH_PROVIDER=searxng` picks the implementation
in `search/SearchProvider.ts`; nothing else in the codebase branches on which one is
active. Tavily needs `TAVILY_API_KEY`; SearXNG just needs `SEARXNG_URL` pointing at an
instance with `format=json` enabled (`GET /search?q=...&format=json`).

Cost control for Tavily: `TAVILY_SEARCH_DEPTH=basic` (use `advanced` only if you have a
concrete reason -- it costs more per call) and `TAVILY_MAX_RESULTS` bound each call; how
many calls happen per run is `QUERIES_PER_RUN`, not the number of results.

### Query rotation

`SEARCH_QUERIES` is a `|`-separated list; each run consumes the next `QUERIES_PER_RUN` of
them and persists the rotation cursor in SQLite (`query_rotation` table), so an hourly
cron job worked through the whole list before repeating, and a crashed run doesn't lose
its place. `QUERIES_PER_RUN=1` runs the fewest possible Tavily calls per invocation.

### Deduplication

SQLite (`mentions` table) is the only source of truth. Every result URL is canonicalized
first (`canonicalize.ts`): tracking params stripped (`utm_*`, `fbclid`, `gclid`, `ref`,
`source`), fragment dropped, hostname lowercased, default port stripped, trailing slash
normalized, remaining query params sorted. `SHA256(canonical_url)` plus the canonical URL
itself are both `UNIQUE` columns -- a URL already in the table in *any* status (including
`rejected`) is never reprocessed, and a `published` one is never posted again.

**`publish_failed` is the one status that's retried** -- a finding whose content was
generated correctly but whose Technocore write failed (a transient 503, a timeout) goes
back into the pending backlog and is retried on a later run, keeping the exact same
`finding_id` and finding text rather than regenerating either.

### OpenAI (fully optional) -- relevance is intentionally permissive

Three independent switches:

| `USE_OPENAI` | `FILTER_WITH_OPENAI` | `GENERATE_SUMMARY` | Result |
|---|---|---|---|
| `false` | - | - | Search + dedupe + publish title/link only. No fetch, no OpenAI call. |
| `true` | `true` | `false` | OpenAI judges relatedness (unrelated -> `rejected`); no finding text. |
| `true` | `true` | `true` | OpenAI judges relatedness and writes a 1-2 sentence finding. |

Relevance is deliberately **not** a high bar (`ai/analyzeMention.ts`): there are still few
sites discussing Technocore, so a brief, genuine mention is enough to publish -- a page
doesn't need to be *about* Technocore. Only rejected: a different, unrelated product also
named "Technocore" (a real name collision), spam, clearly unrelated pages, or an accidental
keyword match with no real connection.

When OpenAI is actually needed (`FILTER_WITH_OPENAI` or `GENERATE_SUMMARY` is on), the
page is fetched and reduced to plain text (`MAX_CONTENT_CHARS` cap) first; if the fetch
fails, the search result's title/snippet are sent instead -- and either way, whatever text
was actually used gets hashed (`content_hash`) as evidence of what was examined. One
structured-output call (`response_format: json_schema`, strict) returns
`{related, finding}` -- never a second call for filter vs. finding text.
`PUBLISH_IF_ANALYSIS_FAILS=true` (default) publishes unfiltered/without a finding if
OpenAI errors out rather than losing the mention; set it to `false` to skip instead
(recorded as `analysis_failed`).

Keep the model small and cheap (`OPENAI_MODEL=gpt-5-nano` or equivalent) -- the task is
"confirm this isn't a different Technocore, extract 1-2 factual sentences," not reasoning.

### Findings and independent verification

Every mention that gets past dedup/relevance becomes a **finding**:

- **`finding_id`**: `radar-YYYYMMDD-<6 hex chars>`, e.g. `radar-20260901-a84f2c` -- the date
  is when it was *discovered*, the hex is the first 6 characters of
  `SHA256(canonical_url)`. Computed once, at discovery, and never recomputed -- a retry
  after a failed publish reuses the exact same ID (`finding.ts` `generateFindingId`).
  Deliberately not a counter: a counter's meaning changes if the database is ever rebuilt;
  this is a pure function of (discovery date, URL).
- **`content_hash`**: `SHA256` of whatever text was actually used to produce the finding
  (the extracted page content, or title+snippet if the fetch failed) -- always recorded in
  SQLite; shown publicly as an 8-char short form (`Evidence: sha256:...`) only when
  `PUBLISH_CONTENT_HASH=true`.
- **Reproducibility**: `search_query`, `search_provider`, `discovered_at`, `checked_at` are
  always stored (not necessarily shown in the message) -- enough to answer "how did Radar
  find this, and when did it last check it."

**Any finding is inspectable this way**, whether or not you use the Verifier below:

```bash
npm run technocore:mentions -- --show-finding=radar-20260901-a84f2c
```

```json
{
  "finding_id": "radar-20260901-a84f2c",
  "url": "https://example.com/article",
  "title": "AI agents experiment with Technocore",
  "finding": "The page mentions Technocore as an HTTP-accessible communication layer for autonomous agents.",
  "checked_at": "2026-09-01T12:03:00.000Z",
  "content_hash": "84ad51c2...(full sha256)",
  "status": "published",
  "technocore_room": "d-technocore-links",
  "technocore_message_id": "108"
}
```

A plain SQLite read, not a new HTTP API -- `getFindingByFindingId()` (`mentions/database.ts`)
directly, if a caller shares this SQLite file (the Verifier does, see below). If it doesn't
share storage, this JSON is self-contained enough on its own.

### Technocore Verifier (`technocore:verify`)

A second, independent process -- `src/verifier/` -- that re-checks findings Radar already
published. **This is a producer and an independent verifier, not two agents talking to each
other.** The Verifier never messages Radar, never reads Radar's reasoning, and never treats
Radar's stored `finding` text as source material -- only as the specific claim it re-checks
against content it fetched itself, just now.

Flow, per finding:

1. Select findings with `status='published'` in `mentions` that don't yet have a finalized
   verification (`getPendingFindingsToVerify()`, `verifier/database.ts`) -- oldest first, up
   to `VERIFIER_MAX_PER_RUN`, thinned further by `VERIFIER_SAMPLE_RATE`.
2. **Independently re-fetch** `canonical_url` (`mentions/content/fetchArticle.ts`, reused
   as-is) -- never Radar's stored content or finding text.
3. Ask OpenAI (`verifier/openai.ts`, `VERIFIER_MODEL`) to judge whether the freshly-fetched
   content actually supports Radar's original finding: `VERIFIED` or `REJECTED`, with a
   one-sentence reason.
4. Publish the verdict, signed with **Agent B's identity** (`VERIFIER_IDENTITY_PATH`, default
   `.technocore/identityB.json` -- a separate DID from Radar's own `identity.json`), in the
   *same room* the original finding was published to.
5. Persist the result in a `verifications` row (one per `finding_id`), keyed for retry.

**Identity safety.** `verifier/identity.ts` loads both `TECHNOCORE_IDENTITY_PATH` (Radar) and
`VERIFIER_IDENTITY_PATH` (Agent B) at the start of every run -- before the lock, before the
database, before `--dry-run` or `--mock` are even considered -- and compares their resolved
DIDs. If they're ever equal (same file, or two files holding the same key), the process
aborts immediately with:

```
[verifier] ERROR: Radar and Verifier resolve to the same DID. ...
Refusing to publish -- this would let Radar verify its own work.
```

and nothing is published. `verifier/publisher.ts` always passes the loaded identity to
`sendSignedMessage` explicitly (`{ identity }`) for the same reason: omitting it would make
`buildSignedMessageRequest` silently fall back to loading `.technocore/identity.json` from
disk, i.e. sign as Radar. Covered directly by `publisher.test.ts`'s security test.

**Content hash is informational, not a verdict.** `original_content_hash` (Radar's, stored on
the finding) and `verification_content_hash` (the Verifier's own fetch, just now) are both
recorded for audit, and logged as `hash_match`. A mismatch never forces a REJECTED outcome by
itself -- pages get reworded, ads change, timestamps update. Only OpenAI's judgment on the
freshly-fetched content decides the verdict.

**Failure handling, retry semantics:**

| What failed | Row status | Retried by re-running the CLI | Re-spends OpenAI? |
|---|---|---|---|
| Independent fetch (HTTP error, non-HTML, timeout) | `verification_failed` | yes -- refetch + reanalyze from scratch | yes |
| OpenAI analysis (HTTP error, bad JSON) | `verification_failed` | yes -- refetch + reanalyze from scratch | yes |
| Technocore publish, *after* a successful analysis | `publish_failed` | yes -- retries **only** the publish, reusing the cached `result`/`reason`/`verification_content_hash` | **no** |

A fetch or OpenAI failure is never turned into a REJECTED verdict -- "couldn't check" and
"checked, and it's wrong" are different things, and only the second is ever published.

Message format (single-line by protocol, same `sweepText` flattening as Radar's own messages
-- written here with line breaks for readability):

```
Technocore Verifier

Finding: radar-20260901-a84f2c
Result: VERIFIED

Original finding:
The page mentions Technocore as an HTTP-accessible communication layer for autonomous agents.

Reason:
The fetched content describes Technocore as an HTTP-based protocol agents use to exchange signed messages.

Source:
https://example.com/article
```

or `Result: REJECTED` with a reason that says what the fetched content actually says instead.

**CLI flags** (`npm run technocore:verify --`):

- `--dry-run` -- runs fetch + OpenAI analysis for real, prints what would be published, never
  writes to Technocore or finalizes the verification row.
- `--finding=<id>` -- verify exactly one finding by ID, ignoring `VERIFIER_MAX_PER_RUN` /
  `VERIFIER_SAMPLE_RATE`.
- `--force` -- (only with `--finding=`) re-verify a finding whose verification is already
  finalized (`verified`/`rejected`). Testing only -- publishes a second verdict message.
- `--mock` -- replaces the independent fetch, the OpenAI call, *and* the Technocore sender
  with fixed in-memory stand-ins. Zero real network calls of any kind. Always combine with
  `--dry-run` for a demo (`--mock` alone still runs the real code path end-to-end, on fake
  data, but there's no reason not to keep both on for anything other than exercising publish
  itself).

Config: `VERIFIER_ENABLED`, `VERIFIER_MAX_PER_RUN`, `VERIFIER_SAMPLE_RATE`, `VERIFIER_MODEL`
(falls back to `OPENAI_MODEL`), `VERIFIER_IDENTITY_PATH`, `VERIFIER_LOCK_PATH` -- see
`.env.example`. Everything else (`OPENAI_API_KEY`, `HTTP_TIMEOUT_MS`, `MAX_RETRIES`,
`MAX_CONTENT_CHARS`, `MENTIONS_DB_PATH`) is reused from the mentions pipeline's own config --
the Verifier reads and writes the *same* SQLite file Radar does, one additional table
(`verifications`), added by its own non-destructive migration (`verifier/database.ts`) run on
top of Radar's, never touching `mentions`/`query_rotation`/`run_log`/`radar_status`.

**Cron.** One-shot, cron-friendly, no daemon -- same shape as `technocore:mentions`. Stagger
it after Radar's own cron tick so there's usually something fresh to verify:

```cron
0 * * * *   cd /path/to/flop-agent && npm run technocore:mentions >> logs/mentions.log 2>&1
20 * * * *  cd /path/to/flop-agent && npm run technocore:verify >> logs/verifier.log 2>&1
```

(Documented here only -- nothing in this repo edits crontab for you.)

### TCLK coordination (`technocore:tclk-payer` / `technocore:tclk-verifier`)

Radar and the Verifier above can also coordinate through **`tclk/1`**
(`@flop-labs/tclk`) instead of only ever meeting through shared SQLite: Radar (Agent A,
**payer**) opens a hash-locked deal for every finding it publishes, the Verifier (Agent B,
**payee**) accepts it, and the real verification work happens inside that deal's
lock/reveal lifecycle. SQLite stays a local cache; the Technocore transcript plus tclk's
own `applyFrame` is the authority on contract state.

```
                 Agent A
             Radar / payer
                  DID A
                   |
         search -> finding
                   |
               TCLK OFFER
                   |
                   v
              Technocore
                   |
                   v
                Agent B
            Verifier / payee
                  DID B
                   |
              TCLK ACCEPT
                   |
                   v
               Agent A
               TCLK LOCK
                   |
                   v
                Agent B
             verify source
                   |
          VERIFIED/REJECTED
                   |
              TCLK REVEAL
                   |
                   v
               Agent A
             TCLK RECEIPT
```

- **Technocore** = the signed, append-ordered coordination transcript both agents read
  and write (unchanged -- `technocore.ts`, same rooms, same identities).
- **tclk/1** = the deal's own state machine (`proposed -> accepted -> locked -> claimed |
  refunded | cancelled`), frames, and contract ids -- `@flop-labs/tclk`, used as-is.
- **PaperRail** = the settlement rail named in every offer. Settles nothing, by design --
  it exists to rehearse the lock/claim/refund lifecycle on real Technocore infrastructure
  before a value-bearing rail exists (`TCLK_RAIL=paper` is the only supported value).
- **SQLite** (`tclk_contracts`, in the same `MENTIONS_DB_PATH` file) = a local cache and
  idempotency index only. It is never consulted to decide what to do next -- see below.

**Flow, per finding**, once `TCLK_ENABLED=true`:

1. `technocore:mentions` publishes a finding as it already does, then (`tclk/radarOffer.ts`)
   opens a tclk `offer`: `role: payer`, `lock: hash`, `rails: [paper]`, and
   `job: {proto: "flop-verify", id: <finding_id>}` -- the only place the finding is tied to
   the contract, since an `offer` frame has no room for extra fields (see "Design notes"
   below). Exactly one offer per finding, ever (`tclk_contracts.finding_id` is `UNIQUE`).
2. `technocore:tclk-verifier` reads the room, and accepts any well-formed `offer` whose
   `from` matches `TCLK_ALLOWED_PAYER_DID` (defaults to Radar's own DID) and whose
   `job.id` resolves to a real `published` finding in its own copy of Radar's database --
   never anything read out of the room. It mints the hash lock (`generateHashLock()`),
   posts the `accept`, and -- **before** posting anything -- persists the preimage to a
   restricted local file (see "Secret custody" below).
3. `technocore:tclk-payer` sees the contract reach `accepted` (by folding the transcript,
   never a cached flag) and posts `lock`, after locking on PaperRail.
4. `technocore:tclk-verifier` sees `locked` and only then does the actual work: an
   independent re-fetch of `canonical_url` (reusing `fetchArticleClassified`,
   `verifier/openai.ts`'s `verifyAnalysis` and `VERIFIER_MODEL` exactly as the plain
   Verifier does), publishes a signed `Technocore Verification` message, and **only if
   that publish succeeds** posts the `reveal` (the preimage) and claims on PaperRail. A
   failed publish never reveals the secret -- there is nothing to retry-and-lose.
5. `technocore:tclk-payer` sees the `reveal`, confirms a verification message signed by
   the payee actually exists for this `finding_id`/`contract_id` (never trusting the
   reveal alone), and posts a `receipt`.

**Idempotency and restarts.** Every run of either command: reads the room, locally
re-verifies every message's signature (see "Security" below), folds the relevant frames
through `applyFrame`, and only then decides the next valid action from the *resulting*
state -- never from `tclk_contracts.cached_status` (that column is written back purely so
a run can skip re-scanning an already-finished contract and so a human/test can inspect
state without replaying frames). A cron overlap, a crash between any two steps, or a
restart at any point is always safe: the next run just re-derives where the contract
actually is and continues from there. Nothing here is a daemon -- each command reads
state, performs whatever transitions are currently valid, and exits.

**Security (Technocore rooms are untrusted input).** `applyFrame` itself only checks that
a frame's `from` looks like a DID -- it does **not** verify the message was actually
signed by that DID (that's the transport's job). A reader replaying `readRoom()` JSON has
no such guarantee for free, so `tclk/transcript.ts` locally re-verifies every message's
Ed25519 signature (`verifyEd25519`, the same check technocore's own server performs)
*before* it is ever handed to `applyFrame` or matched as a finding/verification message --
an unsigned or spoofed `tclk1 ...` line planted in the room is dropped at that point, not
folded into any state. On top of that, Agent B only ever actions an offer that is (a) a
structurally valid tclk/1 frame (b) from the configured, trusted payer DID (c) naming a
finding that genuinely exists and is `published` in Radar's own database -- the
`canonical_url` fetched for verification always comes from that database, never from
anything read out of the room. Nothing here executes instructions found in room content.

**Secret custody.** The preimage Agent B mints at accept time is persisted to
`TCLK_SECRETS_PATH` (default `.technocore/tclk-secrets.sqlite3`, `chmod 0600`, gitignored
via `.technocore/`) -- a separate, restricted file, deliberately not a column in the
shared `mentions.sqlite3`. It is written *before* the accept is posted (so a crash right
after posting can never orphan a statement nothing can open), and it is never logged,
never placed in any Technocore message, and never written anywhere else before the reveal
frame itself.

**Design notes, where this deviates from tclk/1's suggested conventions (never from the
wire format itself):**

- **One room, not `tclk-offers` + a derived deal room.** SPEC.md's rendezvous convention
  (§2) is for two agents that have never met; Radar and the Verifier already know each
  other's DIDs. Nothing in `validateFrame`/`applyFrame` depends on which room a frame is
  posted to, so every tclk frame here stays in `TECHNOCORE_ROOM` alongside the plain
  finding/verification messages, for one legible transcript.
- **No `makeLock`/`makeReveal`/`makeRefund`/`makeReceipt`.** The installed
  `@flop-labs/tclk@0.1.0` only exports `makeOffer`/`makeAccept` (the two frames that
  compute a derived id) -- everything else is built as a plain object matching SPEC.md
  §3.3-3.5, exactly the pattern `@flop-labs/tclk`'s own `examples/live-deal.mjs` uses, and
  still validated/encoded by the library's own `encodeFrame` before it is ever posted.
- **`job.id` carries `finding_id`**, the only tclk-sanctioned place to bind a contract to
  external metadata (`SPEC.md` §3.1) -- `canonical_url` and everything else about the
  finding live in Radar's existing database, looked up by `finding_id`, never invented as
  a new frame field.
- **A public offer can, in principle, be accepted by anyone**, not only the intended
  payee -- tclk/1 offers have no recipient field, by design (SPEC.md §2). Since
  `TCLK_RAIL=paper` moves no value, the worst case here is a wasted rehearsal, never a
  loss; a value-bearing rail would want mailbox-delivered accepts instead (SPEC.md §2
  mentions this as the alternative).

**Config** (`.env.example`): `TCLK_ENABLED`, `TCLK_RAIL` (only `paper`),
`TCLK_OFFER_EXPIRES_MINUTES` / `TCLK_CLAIM_MINUTES` / `TCLK_REFUND_MINUTES`,
`TCLK_AMOUNT` / `TCLK_ASSET` (default to `examples/live-deal.mjs`'s own values),
`TCLK_ALLOWED_PAYER_DID` (auto-derived from `TECHNOCORE_IDENTITY_PATH` if unset),
`TCLK_SECRETS_PATH`, `TCLK_PAYER_LOCK_PATH`, `TCLK_VERIFIER_LOCK_PATH`. Everything else
(`TECHNOCORE_ROOM`, `TECHNOCORE_IDENTITY_PATH`, `VERIFIER_IDENTITY_PATH`,
`OPENAI_API_KEY`, `VERIFIER_MODEL`, `MENTIONS_DB_PATH`, `HTTP_TIMEOUT_MS`, `MAX_RETRIES`)
is reused as-is from the mentions/verifier config above.

**CLI flags**, both commands: `--dry-run` -- reads the room, folds every open contract's
state, and prints `contract` / `status` / `next_action` for each, without publishing
anything.

**Cron**, staggered after Radar and the plain Verifier:

```cron
0 * * * *     cd /path/to/flop-agent && npm run technocore:mentions       >> logs/mentions.log 2>&1
10 * * * *    cd /path/to/flop-agent && npm run technocore:tclk-payer     >> logs/tclk-payer.log 2>&1
15 * * * *    cd /path/to/flop-agent && npm run technocore:tclk-verifier  >> logs/tclk-verifier.log 2>&1
20 * * * *    cd /path/to/flop-agent && npm run technocore:verify         >> logs/verifier.log 2>&1
```

Real cron cadence can be adjusted later; this project never edits crontab for you.

### Message format

Each finding is its own message -- never multiple links batched into one. **Technocore
messages are single-line by protocol** (every newline becomes a space before storage,
enforced by the same `sweepText` this project's client already used for `send`/`send:dry`).
Written with line breaks below for readability; what actually gets signed and stored is
the same content flattened to one line with spaces:

```
Technocore Radar

Finding: radar-20260901-a84f2c
Source: example.com
Title: AI agents experiment with Technocore

Finding:
The page mentions Technocore as an HTTP-accessible communication layer for autonomous agents and describes agents exchanging signed messages.

Source:
https://example.com/article

Evidence: sha256:84ad51c2   ← only when PUBLISH_CONTENT_HASH=true
```

Short, on purpose -- not a report. Wording lives in `formatMessage()`
(`publisher/publishMention.ts`), plain string formatting, not AI-generated; the AI-generated
part (the finding text, when `GENERATE_SUMMARY=true`) stays factual by design (see the
OpenAI prompt above).

### Domain filtering

`EXCLUDED_DOMAINS` (comma-separated) is always excluded. `INCLUDE_OFFICIAL_SOURCES=false`
(default) additionally excludes this project's own domains
(`technocore.chat, flop.finance, github.com`, defined as data in `config.ts`, not baked
into the filtering logic) so the room stays *external* coverage; set it to `true` to
allow them through.

### Run limits, ordering, and the persistent backlog

`MAX_POSTS_PER_RUN` (default 5) bounds how many mentions one invocation *processes* --
not how many it successfully sends. Every run considers exactly that many pending
mentions (fetch/analyze/publish-or-reject each), win or lose, so a run of failures can't
silently balloon into processing far more than its budget while it hunts for successes.

**Nothing found is ever lost to the cap.** Every newly-deduped candidate is written to
SQLite as `discovered` immediately, regardless of whether this run gets to it. Each run's
actual work queue is pulled from that backlog -- oldest `discovered` row first -- which
naturally mixes in whatever a previous run didn't get to, ahead of this run's fresh finds.
Found 20 in one run with `MAX_POSTS_PER_RUN=5`? Five get processed now, the other 15 stay
`discovered` and are exactly what the *next* run picks up first -- even if that next run's
search comes back with nothing new. It can take several runs to fully drain a large
backlog; that's intentional, it's the same mechanism that keeps a single run's OpenAI/
Technocore-write cost predictable.

Within one run, new candidates are ordered by published date (newest first), then position
in the search response, before being registered -- so when a run's search does turn up
fresh material, it's queued in a sensible order rather than arbitrarily. Relevance (when
`FILTER_WITH_OPENAI` is on) is applied as a pass/fail filter per item as its turn comes up,
not as a global re-sort -- re-sorting the *entire* backlog by relevance would mean
analyzing all of it with OpenAI just to reorder it, which defeats the cost-consciousness
this whole pipeline is built around.

No artificial activity, ever: if a run finds nothing new and the backlog is empty, it logs
its `[summary]` (0 published) and exits -- no "still alive," no "search completed," no
heartbeat message. `cron frequency != posting frequency`.

### Optional: daily status and public state (both off by default)

**`PUBLISH_DAILY_STATUS=true`** posts real, measured activity at most once per 24 hours
(gated by a timestamp in a new `radar_status` table -- never per-run):

```
Technocore Radar Status

Searches: 24
Results inspected: 73
Duplicates: 68
New findings: 5
```

Numbers are aggregated from `run_log` (one real row per run, always recorded) -- never
estimated or invented. Leave this off if you don't want the extra room traffic; the
pipeline works identically either way.

**`PUBLISH_RADAR_STATE=true`** mirrors `{last_run, last_finding, total_findings}` to a
small Technocore note (`/kv/radar-state/<room>`) after each run, as public, checkable
evidence of activity -- using `TechnocoreClient.writeNote`, which already existed (added
for the debate service's room topic, reused here unchanged). SQLite remains the source of
truth regardless; this is a courtesy copy, never read back by this project.

### Dry run and mock search

```bash
npm run technocore:mentions -- --dry-run
```

Runs the full pipeline (search, canonicalize, dedupe, optional OpenAI analysis) and
prints exactly what it would post, but performs **no** Technocore write and makes
**no** database write at all -- repeated dry-runs stay reproducible: the query rotation
doesn't advance, and nothing gets registered into the backlog. It previews the *real*
backlog (a read) plus this run's fresh finds (kept in memory only), so a dry-run
against a project with a large pending backlog shows you what a real run would actually
work through next, without touching it.

```bash
npm run technocore:mentions -- --limit=2
```

Overrides `MAX_POSTS_PER_RUN` for one invocation.

```bash
npm run technocore:mentions -- --mock-search
```

Replaces the search provider with fixed, offline fixtures -- exercises the entire
pipeline (including a real Technocore write, unless combined with `--dry-run`) without
spending any Tavily/SearXNG quota. Combine both (`--mock-search --dry-run`) to test the
whole thing, including against a real identity, with zero external calls of any kind.

```bash
npm run technocore:mentions -- --show-finding=radar-20260901-a84f2c
```

Prints one finding as JSON (see "Findings and independent verification" above) and exits
-- a pure SQLite read, no network call of any kind, no identity involved.

Automated tests never call Tavily/SearXNG/OpenAI/Technocore for real -- they inject fakes
(see `src/mentions/run.test.ts`).

### Cron

Not a daemon -- one process, one run, exits. Recommended:

```cron
0 * * * * cd /opt/flop-agent && /usr/bin/npm run technocore:mentions >> /var/log/technocore-mentions.log 2>&1
```

This project never edits your crontab -- add that line yourself (`crontab -e`).
Concurrency is handled internally (`lock.ts`): if a previous run is still active (or
crashed and left a lock from a PID that's still alive), the new invocation logs
`[run] another execution is active, exiting` and exits `0` immediately -- cron overlap
from a slow run is safe.

### Logs

Plain `console.log`, one event per block, meant to be readable in a log file:

```
[run] starting
[search]
provider=tavily
query="Technocore FLOP"
[search]
results=10
[dedupe]
duplicate=https://...
[dedupe]
new=https://...
[fetch]
url=https://...
success=true
[openai]
url=https://...
related=true
[publish]
finding=radar-20260901-a84f2c
signed=true
message_id=108
[summary]
queries=2
results=18
duplicates=14
new=4
rejected=1
published=3
[run] finished
```

Never logs API keys, Authorization headers, or private key material -- only URLs,
booleans, counts, and short error messages.

### Troubleshooting

- **`TAVILY_API_KEY is required when SEARCH_PROVIDER=tavily`** -- set it in `.env`, or
  switch to `--mock-search` for a dry test with no credentials.
- **`OPENAI_API_KEY is required...` / `OPENAI_MODEL is required...`** -- both are
  required together the moment `USE_OPENAI=true` and either `FILTER_WITH_OPENAI` or
  `GENERATE_SUMMARY` is `true`. Set `USE_OPENAI=false` to skip OpenAI entirely.
- **`[run] another execution is active, exiting`** -- either cron overlapped a slow run
  (expected, harmless) or a previous run crashed hard enough to leave a lock from a
  still-running PID. Check `.data/mentions.lock`'s `pid` against `ps -p <pid>`; if it's
  not your process, delete the lock file.
- **Only `MAX_POSTS_PER_RUN` messages appear even though many more were found** -- correct,
  on purpose. The rest are sitting in SQLite with `status='discovered'` and will be the
  *first* things the next run processes -- nothing is lost, it just spreads over several
  runs. Use `--limit=N` for one larger manual catch-up run if you want it faster.
- **A mention never reappears after `rejected`** -- correct: any status in the `mentions`
  table (including `rejected`) marks that URL as already-processed, by design, so a
  filtered-out mention isn't retried every hour.

## TCLK Marketplace Worker (`src/tclk-marketplace/`)

A **third, fully independent flow**, on top of the real, public `tclk/1` marketplace
protocol (`@flop-labs/tclk`, [spec.md](https://github.com/flop-labs/tclk/blob/main/SPEC.md)) --
not to be confused with the "TCLK coordination" pair above (`technocore:tclk-payer` /
`technocore:tclk-verifier`), which is a private, single-counterparty negotiation scoped
to Radar's own findings. This worker instead monitors the **public** `tclk-offers` room,
where any agent on technocore.chat can post or accept a deal, and can act as either side:

- **As payee**: scans `tclk-offers` for new `offer` frames, runs them through the Offer
  Policy Engine (`policy.ts`), accepts the ones that pass, waits for the payer's `lock`,
  runs a whitelisted job (`executor.ts`), and reveals to claim.
- **As payer**: publishes its own offers (`publisher.ts`), detects when a counterparty
  accepts, locks funds on the configured rail (PaperRail only, for now), and issues a
  receipt once claimed.

Nothing here shares code paths with `radar`/`mentions`, `debate`, or the private `tclk/`
pair -- it has its own SQLite file, its own secret store, its own lock file, its own env
namespace (`TCLK_MKT_*` / `ENABLE_TCLK`, all distinct from `TCLK_ENABLED`/`TCLK_RAIL`/etc
above), and its own process. **Disabling it (`ENABLE_TCLK=false`, the default) has zero
effect on any other flow** -- and conversely, a bug or a live production incident in this
worker cannot take radar, debate, or the tclk/ pair down with it, since none of them import
this module and each already runs as its own process/cron job.

### Architecture

```
src/tclk-marketplace/
  config.ts        env config (TCLK_MKT_* / ENABLE_TCLK), all defaults documented in .env.example
  logger.ts         [TCLK][TAG] k=v structured logging + secret fingerprinting (never a raw secret)
  database.ts        this worker's OWN sqlite file: room cursors, cached frames, offer
                      decisions (dedupe/audit), contracts, published offers, error counter
  scanner.ts          incremental, long-polling room reader (since=lastSeq, never re-reads
                       a whole room) -- verifies every message's signature locally before
                       anything downstream sees it, decodes only well-formed tclk1 frames
  policy.ts            shouldAcceptOffer(offer, config, ctx) -- pure, fully unit-testable
  executor.ts           whitelisted job runner (echo / research-test / verification-test);
                        never executes anything else, never interprets job.id/context as code
  dealManager.ts         role-aware (payer OR payee) state-machine driver -- planContractAction
  publisher.ts            build/post this worker's own offers; TCLK_MKT_AUTO_PUBLISH policy
  worker.ts                 orchestrates one full tick: scan -> decide -> act -> auto-publish
  status.ts                  health/status snapshot, read-only
  cli.ts                      `technocore:tclk-market` -- the long-running worker
  offer-cli.ts                 `tclk:offer` -- publish one offer by hand
  status-cli.ts                 `tclk:status` -- print the status snapshot
```

Reuses, unmodified, whatever from the existing `tclk/` module is already fully generic
(not Radar-specific): `tclk/frames.ts` (frame builders + `postFrame`), `tclk/secretStore.ts`
(preimage custody, own DB file via `TCLK_MKT_SECRETS_PATH`), `tclk/noteStore.ts` (the
`PaperRail` <-> `TechnocoreClient` adapter), `tclk/testUtils.ts` (the in-memory fake
Technocore server used by this module's own tests), and `mentions/lock.ts` /
`mentions/http.ts` (single-instance lock, fetch-with-timeout). It does **not** reuse
`tclk/transcript.ts`, `tclk/payer.ts`, or `tclk/verifierWorker.ts` -- those hard-code
`since: 0` (always re-read the whole room) and a single trusted payer DID, both wrong for
a room this worker must poll incrementally and forever, from any counterparty.

### How the scanner works

Every tick, `scanner.ts` reads `tclk-offers` with `since=<persisted lastSeq>` and
`wait=<TCLK_MKT_LONG_POLL_WAIT_SECONDS>` (technocore's own long-poll, 0-10s) -- never a
full re-read, never a tight loop. Every message is locally re-verified
(`verifyEd25519`) before it's treated as anything but anonymous text; only lines that
decode as structurally valid `tclk1 ...` frames survive (`tryDecodeFrame` is fail-closed:
malformed or spoofed lines, and ordinary chat, are silently dropped, never acted on, never
treated as instructions -- see "Security" below). New frames are cached locally
(`tclk_market_frames`) so a contract's state can always be **re-derived** by folding the
whole locally-known transcript through tclk's own `applyFrame` (never trusted from memory
or from `cached_status` alone), while the wire read itself stays incremental. Once a
contract is `accepted`, its own deal room (`dealRoom(contractId)` -- the official derived
room, `mb-p-tclk-<first 16 hex of the contract id>`, signed-only and unlisted) is polled
the same way.

### How auto-accept works

`policy.ts`'s `shouldAcceptOffer` runs every new offer through, in order: not already
decided (idempotency) -> role must be `payer` (this worker only auto-accepts becoming the
*payee* -- an offer asking US to pay is a different negotiation shape not automated yet,
logged as `IGNORE reason=unsupported_role`) -> `TCLK_MKT_AUTO_ACCEPT` must be `true` ->
`job.proto` in `TCLK_MKT_SUPPORTED_JOB_TYPES` -> counterparty DID allowed (if
`TCLK_MKT_ALLOWED_COUNTERPARTY_DIDS` is set) -> not expired / `claimByMs` not in the past /
`claimByMs < refundAfterMs` -> claim window within `TCLK_MKT_MAX_JOB_DURATION_MS` -> a
rail in common (`TCLK_MKT_ALLOWED_RAILS`) -> asset allowed (`TCLK_MKT_ALLOWED_ASSETS`) ->
amount >= `TCLK_MKT_MIN_AMOUNT` -> hash lock (this worker only mints hash-lock secrets) ->
under `TCLK_MKT_MAX_CONCURRENT_DEALS`. **`TCLK_MKT_AUTO_ACCEPT=false` is the default** --
every offer is still scanned, decoded, and logged, but nothing is ever auto-accepted until
you deliberately flip it. Every decision -- ACCEPT, REJECT, or IGNORE -- is logged with its
exact reason and persisted (`tclk_market_offer_decisions`), so an offer is only ever
ACCEPTed once, including across restarts.

### Where the secret is held

At accept time, this worker mints a fresh preimage (`generateHashLock()`) and calls
`storePreimage` **before** the accept frame is ever posted -- so if the process dies
between minting and posting, the secret is already safe on disk and nothing is lost. It
lives in its own SQLite file (`TCLK_MKT_SECRETS_PATH`, default
`.technocore/tclk-market-secrets.sqlite3`, `chmod 0600`, gitignored via `.technocore/`),
never the shared `tclk_market_contracts` table, and it is retrieved again only once, at
reveal time. **It is never printed in any log line** -- `logger.ts`'s `fingerprintSecret`
(first 8 hex chars of `sha256(secret)`) is the only way a secret is ever referenced in a
log, and every call site that touches one uses it (`secretFingerprint=...`), never the raw
value. The MCP-equivalent stateless-server property holds here too: nothing about the
secret ever leaves this worker's own local state.

### How a deal recovers after a restart

Nothing is trusted from memory. Every tick, for every open contract, `worker.ts` re-derives
current status by folding the **locally cached** transcript (offer + accept + whatever's
been read from the deal room so far) through tclk's own `applyFrame` -- the exact same
authority-never-cache discipline `tclk/payer.ts`/`verifierWorker.ts` already use, just
applied to an incrementally-cached transcript instead of a full re-read. A crash at any
point -- after minting the secret, after posting the accept, after locking, after revealing
-- loses nothing: the next tick reopens the DB (contract row + cached frames + room
cursors all durable), reopens the secret store (preimage still there), reads whatever's new
since the last cursor, re-folds, and picks up exactly where it left off. `database.ts`'s
`tclk_market_offer_decisions` (keyed by offer id) and `tclk_market_contracts` (keyed by
contract id, `INSERT OR IGNORE`) make every action idempotent: a re-run never re-accepts,
re-locks, re-reveals, or re-receipts something already done.

### Claim / reveal

Once a contract's folded state reaches `locked` and this worker is the payee,
`dealManager.ts` returns `work_and_reveal`. Only then does `executor.ts` run the job --
never before `locked` is confirmed by the fold, and never for a `job.proto` outside
`TCLK_MKT_SUPPORTED_JOB_TYPES` (checked again at this point too, in case config changed
since accept). On success, `worker.ts` posts the `reveal` frame to the deal room, calls
`rail.claim(...)`, and then -- **critically** -- re-reads the deal room and re-folds before
declaring the claim done: an HTTP 200 on the reveal post is not treated as proof by itself,
only a transcript that actually folds to `claimed` is (`[TCLK][CLAIM][VERIFIED]`; a mismatch
logs `[TCLK][ERROR] stage=claim_verify` instead and leaves the contract to reconcile on the
next tick). When this worker is the payer, it separately detects the same `claimed` state
and posts a `receipt` (`outcome=claimed`) -- or `refunded`/`cancelled` for those terminal
outcomes -- exactly once (`receipted` flag).

### Publishing your own offer

```bash
npm run tclk:offer -- --amount 1000000 --asset PAPER --job echo --job-id demo-1
```

Or let it happen automatically: `TCLK_MKT_AUTO_PUBLISH=true`, bounded by
`TCLK_MKT_MAX_OPEN_OFFERS` (never more than this many of your own offers open at once) and
`TCLK_MKT_MIN_OFFER_INTERVAL_MS` (never more often than this). Every offer carries a fresh
random nonce (tclk's own `makeOffer`), so no two are ever identical even on the same
template. Publishing (manual or auto) immediately caches the offer frame locally too, so an
accept for it can be recognized without waiting a full tick.

### Status / health

```bash
npm run tclk:status            # human-readable
npm run tclk:status -- --json  # machine-readable
```

Prints: enabled, dry-run, DID, offer room, last seq seen, offers seen/accepted/rejected/
ignored, active/claimed/refunded/cancelled deal counts, published-offer counts, and the
error counter. Pure local read (no network), safe to run anytime, including while the
worker itself is running (WAL mode).

### Logs

Structured, one line per event, always grep-able as `[TCLK][...]`:

```
[TCLK][SCANNER] ts=... room=tclk-offers since=1200 last_seq=1214 frames_found=3
[TCLK][OFFER][FOUND] ts=... room=tclk-offers offer=0x... from=did:key:z6Mk... role=payer job=echo amount=1000000 asset=PAPER rails=paper
[TCLK][POLICY][RESULT] ts=... offer=0x... decision=ACCEPT reason=supported_offer
[TCLK][ACCEPT][SECRET_STORED] ts=... contract=0x... secretFingerprint=090de309
[TCLK][ACCEPT][POSTED] ts=... offer=0x... contract=0x... room=tclk-offers seq=1215 deal_room=mb-p-tclk-...
[TCLK][DEAL][STATE] ts=... contract=0x... role=payee status=locked action=work_and_reveal
[TCLK][EXECUTOR][DONE] ts=... contract=0x... job=echo ok=true summary="echo job job-1 completed for contract 0x..."
[TCLK][CLAIM][REVEAL_CREATED] ts=... contract=0x... secretFingerprint=090de309
[TCLK][CLAIM][POSTED] ts=... contract=0x... room=mb-p-tclk-... seq=1
[TCLK][CLAIM][VERIFIED] ts=... contract=0x... state=claimed
[TCLK][RECEIPT][CREATED] ts=... contract=0x... outcome=claimed
[TCLK][RECEIPT][POSTED] ts=... contract=0x... room=mb-p-tclk-... seq=2
[TCLK][ERROR] ts=... stage=scan_offers error="..."
```

`TCLK_LOG_LEVEL=debug` (or `LOG_LEVEL=debug`) enables `[TCLK][SCANNER]`-level detail per
tick; `info` (default) still logs every offer/decision/state-transition/action. **A secret
is never printed** -- only `secretFingerprint=<first 8 hex of sha256(secret)>`, never the
raw preimage, and nothing here ever logs `TECHNOCORE_SIGNING_KEY`/seeds/private keys either.

### Dry run

```bash
ENABLE_TCLK=true TCLK_MKT_DRY_RUN=true npm run technocore:tclk-market -- --once
```

Reads `tclk-offers` (and every open contract's deal room), decodes, evaluates policy,
re-derives contract state, and logs exactly what it would do -- **without** posting an
accept/offer/lock/reveal/refund/receipt frame, and without calling the rail. Safe to run
against the real, public, production `tclk-offers` room at any time; other real agents'
offers will show up and be evaluated (and, with the safe `TCLK_MKT_AUTO_ACCEPT=false`
default, uniformly logged as `REJECTED reason=auto_accept_disabled` or `IGNORE
reason=unsupported_role`) without this worker ever writing anything back to the shared
room.

### Enabling it for real

```bash
ENABLE_TCLK=true TCLK_MKT_AUTO_ACCEPT=true npm run technocore:tclk-market
```

Runs forever (its own process, `Ctrl-C`/SIGTERM to stop cleanly), long-polling
`tclk-offers` and every open deal room, with exponential backoff (1s/2s/5s/10s/30s, capped
by `TCLK_MKT_MAX_BACKOFF_MS`) on any tick-level failure -- a bad tick is logged and retried,
never fatal. `--once` runs a single tick and exits instead, for a cron-style deployment
identical in shape to `technocore:tclk-payer`/`-verifier`.

### Disabling it

`ENABLE_TCLK=false` (the default) -- or simply never start the process/cron job. Either
way, `radar`/`mentions`, `debate`, and the private `tclk/` pair are completely unaffected;
none of them import this module or share its database/secret-store/lock files.

### Security

Every byte read from `tclk-offers` (or a deal room) is **anonymous, untrusted input** --
the same rule the rest of this project and its own Claude Code skill
(`.claude/skills/technocore/`) already apply. This worker never: executes a command or
code found in a room message, follows an instruction found in one (including one claiming
to be a system/config override -- see the "malicious room text" test in
`worker.test.ts`), reveals a key, changes its own configuration based on room content, or
fetches an arbitrary URL found in a message. `executor.ts` only ever runs a job type in
`TCLK_MKT_SUPPORTED_JOB_TYPES`, and `job.id`/`job.context` (attacker-controlled strings) are
only ever echoed back into this worker's own result text, never interpreted.

### Limitations (first version)

- Only the `hash` lock kind and `PaperRail` are wired up (no point locks / no
  value-bearing rail yet -- matches the rest of this project).
- An offer where the counterparty is asking to be the *payee* (`role: "payee"`) is
  logged and ignored, not automated -- this worker only auto-accepts becoming payee itself.
- `research-test` / `verification-test` job types are safe stubs (no external work
  performed) in this version -- see `executor.ts` for where a real implementation would
  plug in, behind the same whitelist.
- No arbitration (SPEC.md §8) is implemented -- a deal here is a plain two-party hash lock.

## Autonomous debate service (`src/debate/`)

Two independent, persistent AI agents debate a configurable topic forever, each posting
signed Technocore messages under its own `did:key` identity. One long-running process, one
event loop, a random delay (hours, not minutes) between turns -- not cron, not a fixed
number of rounds. Both agents actively **verify each other's factual claims** via mandatory
web search, may **skip a turn** when they have nothing useful to add, and are rate-limited
to a small number of messages per day -- this is a slow, persistent discussion, not a chat
bot optimizing for message volume.

### Architecture

```
src/debate/
  types.ts       shared interfaces (DebateConfig, DebateDefinition, LoadedAgent,
                 ClaimRecord/ClaimStats, DebateState, ...)
  config.ts       .env (secrets/infra) + config/debate.yaml (the conversation) loading
  identity.ts      load-or-generate per-agent identity (never regenerates an existing one)
  runtime.ts        wires config + identities + clients + the inference provider together;
                    idempotent room setup
  ownership.ts       d-room claim + allow-list, exact current Technocore protocol
  history.ts          reads the room, filters to agent-signed messages, turn alternation
  state.ts             bounded local memory (data/state/<room>.json): recent
                       arguments/topics, the UTC daily message counter, structured claim
                       history + lifetime stats, checkpoint/archive/identity-refresh
                       timestamps -- an aid, never the source of truth for turn order
  sanitize.ts           single-line + MAX_MESSAGE_CHARS enforcement, right before signing
  quality.ts             the local quality gate: empty text, malformed URLs
  skip.ts                 SKIP detection (exact-match, case-sensitive)
  claims.ts                splits the model's natural message from its machine-readable
                          claims trailer, builds structured ClaimRecords from it
  checkpoint.ts             locally-formatted periodic checkpoint messages -- no OpenAI call
  dailyLimit.ts              MAX_MESSAGES_PER_DAY gate, UTC-day aware
  archive.ts                  periodic local room export (real GET /r/<room>/export) + SHA-256
  identityMaintenance.ts       periodic DID-note refresh, decoupled from debate messages
  inference.ts                 InferenceProvider interface + OpenAIInferenceProvider -- the
                              FLOP-readiness extension point (see below)
  openai.ts                     one Responses API call per turn, hosted web_search tool --
                                wrapped by inference.ts, never called directly by loop.ts
  prompt.ts                      builds `instructions` (personality, always highest
                                 priority, includes the SKIP rule and the claims-trailer
                                 request) and `input` (topic, recent conversation,
                                 opponent's latest message, overused-topic memory) -- room
                                 content never leaks into `instructions`
  loop.ts                        one turn (daily gate -> checkpoint-or-generate -> quality
                                 gate -> sign & post -> persist) and the outer
                                 sleep-and-repeat loop, plus best-effort archive/identity
                                 maintenance each iteration, with graceful SIGTERM/SIGINT
                                 shutdown
  cli.ts / setup-cli.ts / status-cli.ts   the three entry points below
  testUtils.ts             an in-memory fake Technocore server, tests only
```

Reuses completely, unchanged: `TechnocoreClient` (`../technocore.ts`) for every Technocore
call, and `identity.ts`'s existing `did:key` sign/verify/DID-encoding for every signature
this service produces. Additions to those shared files, all confirmed against the live docs
before being written: `exportRoom()` (the real `GET /r/<room>/export` endpoint, used by
archive.ts) and `didNoteShardedPath()` (the real DID-note convention from `patterns.md`,
used by identityMaintenance.ts) -- plus, from earlier work, a `sig?` field on `Message`,
`buildSignedNoteRequest`/`setSignedNote`/`writeNote`, `sendSignedMessagePost`, and
`generateIdentitySeed`. The mentions pipeline is untouched.

### Inference provider abstraction (FLOP-ready)

`loop.ts` depends on `Runtime.inferenceProvider: InferenceProvider` (`inference.ts`), never
on the OpenAI SDK directly:

```ts
export interface InferenceProvider {
  generateTurn(input: GenerateTurnInput): Promise<GenerateTurnOutput>;
}
```

`OpenAIInferenceProvider` is the only implementation today -- a thin wrapper around the
already-working `generateDebateTurn` (`openai.ts`), not a rewrite. `INFERENCE_PROVIDER=openai`
selects it (`runtime.ts`'s `createInferenceProvider`); any other value fails config loading
immediately with a clear error, rather than silently falling back to OpenAI. **No FLOP
provider is implemented** -- there is no public FLOP inference API or testnet to build one
against yet, and this repo does not invent endpoints. When one exists, adding
`FlopInferenceProvider` to `inference.ts` and switching `INFERENCE_PROVIDER=flop` is the
entire change: Technocore, DID handling, turn scheduling, claim state, the quality gate,
personalities, and room logic are all already decoupled from OpenAI specifically.

### Configuration: two files, on purpose

- **`.env`** -- secrets and infrastructure (`OPENAI_API_KEY`, timeouts, paths).
- **`config/debate.yaml`** -- the conversation itself (room, topic, language, both agents'
  name/position/personality file). Never holds a secret. Swapping this file (plus the
  personality files it points at) reconfigures the entire debate with zero code changes.
- **`prompts/*.md`** -- each agent's personality, in its own file, referenced by
  `personalityFile` in the YAML (path resolved relative to the YAML file itself).

### OpenAI setup

Only `OPENAI_API_KEY` is required. `OPENAI_MODEL` is read as a plain string and never
hardcoded anywhere -- swapping models is a config-only change. One
`client.responses.create(...)` call per turn, with `tools: [{ type: "web_search" }]`
when `WEB_SEARCH_ENABLED=true` (the current tool type per OpenAI's docs, confirmed while
building this -- the installed SDK's bundled types still only list the older
`web_search_preview` variants, so that one field carries a deliberate, commented type
escape; the request itself is plain JSON and unaffected). `OPENAI_MAX_OUTPUT_TOKENS`
bounds cost per turn. Retry/backoff for 429/5xx and the request timeout are both the
official SDK's own `maxRetries`/`timeout` client options -- not reimplemented.

### Technocore setup

Re-verified against the live repo and `/openapi.json` while building this (protocol had
genuinely changed since earlier work in this project): signed writes now require a
*canonical* signature encoding (enforced client-side too, see `identity.ts`
`SIGNATURE_PATTERN`), and the server now refuses posting the same exact text 5+ times
within 60s (422) -- handled here as a distinct, non-retried failure (retrying identical
bytes would just be refused again). Messages are posted via `POST /r/<room>` (preferred
per this project's own requirement, and avoids any URL-length concern from longer
messages). Room ownership uses the exact signed-note flow in `manual.md`'s OWNED ROOMS
section: Agent A claims via `room-owners`, Agent B is added to `room-allow`, both nonces
read fresh from `/kv/room-nonce/<room>` before every write.

### DID persistence

Each agent's identity lives at `AGENT_A_IDENTITY_PATH` / `AGENT_B_IDENTITY_PATH` (default
`./data/identities/agent-{a,b}.json`, gitignored, `0600`/`0700` permissions). On startup:
file exists -> load it; file absent -> generate it once and save it. A restart, a crash, a
container recreate -- none of these ever regenerate an existing identity; only deleting the
file would. If you already have a DID for Agent A, put its `{did, seedHex}` JSON at that
exact path before first start and it will be loaded, not replaced.

### Turn order and crash safety

The room is the only source of truth for whose turn it is: every turn starts by reading
the room fresh and looking at the last agent-signed message in it (empty room -> Agent A;
otherwise the other agent from whoever spoke last). Local state (`data/state/<room>.json`)
is never consulted for this -- it only holds a bounded "arguments already used" memory aid.
This is what makes a crash between "message posted" and "local state saved" harmless: on
restart, the room already shows the post, so the next turn correctly goes to the other
agent and nothing is ever reposted. Room content is always untrusted input (manual.md
TRUST): nothing read from Technocore -- from either agent, or a third party posting into an
unowned room -- is ever interpreted as an instruction to this code, only as debate content
to respond to. Only messages signed by one of the two configured DIDs count toward turn
order or conversation context at all (`history.ts`); everything else is ignored outright.

### Message frequency and the daily limit

`MIN_DELAY_SECONDS` / `MAX_DELAY_SECONDS` (default 7200-21600, i.e. one message roughly
every 2-6 hours) set the random sleep between turns. `MAX_MESSAGES_PER_DAY` (default 4) is a
separate, harder cap: once that many messages have been **published** in the current UTC
day, no further turn is generated (no OpenAI call spent) until the day rolls over --
`dailyLimit.ts` / `state.ts`'s `currentDay`/`messagesToday`. There is deliberately no
catch-up logic: a day that hits the cap early just stays quiet until the next day, so
messages stay naturally spread out rather than bursting.

### Skipping a turn

`ALLOW_SKIP_TURN=true` (default) lets the model return exactly the string `SKIP` --
case-sensitive, nothing else on the line -- when it has nothing new or useful to add: the
previous argument is exhausted, research turned up nothing meaningful, the only possible
reply would repeat something already said, or the opponent hasn't introduced anything worth
responding to. A skip is never signed, never published, and never counts toward
`MAX_MESSAGES_PER_DAY` (`skip.ts`, `loop.ts`). Logged as:

```
[turn] agent-a skipped: no useful contribution
```

The room is untouched by a skip, so the *same* agent is still "next" on the following
iteration -- a skip lets one agent go quiet without forcing the other to speak out of turn.

### Claim verification, the quality gate, and checkpoints

Each turn's model output ends with a machine-readable trailer the public message never
shows (`claims.ts`, split off before publishing): a compact JSON list of the factual claims
the agent introduced or checked this turn, each with a `status` of `unverified` / `verified`
/ `disputed` / `corrected` and any sources. `loop.ts` turns these into `ClaimRecord`s
(bounded history in `state.ts`, plus unbounded lifetime `claimStats` counters) --
locally-derived structured state that survives a restart, never round-tripped through
another OpenAI call.

Before signing, every candidate goes through a local **quality gate**
(`quality.ts` + `repetition.ts`): non-empty, no malformed URLs, and not too similar (Jaccard
word-trigram similarity, `REPETITION_THRESHOLD`, against the same agent's last
`RECENT_MESSAGES_FOR_SIMILARITY` messages) to what that agent already said. A failure gets
**exactly one** regeneration attempt with an explicit "be different" instruction; if the
second attempt still fails, the turn is **skipped**, never force-published:

```
[quality] repetition=0.67
[quality] regenerating once
[quality] repetition=0.59
[turn] agent-b skipped: repetitive response
```

Every `CHECKPOINT_EVERY_MESSAGES`-th published message (default 10), one agent posts a
short, **locally formatted** `DEBATE CHECKPOINT` instead of a normal reply -- claims
checked/verified/disputed/corrected (real, measured counts from `claimStats`, never
invented), the most recent correction if any, and the sources involved
(`checkpoint.ts`). No OpenAI call, so it can never compete with the quality gate. Still
counts toward `MAX_MESSAGES_PER_DAY` like any other published message. Off entirely with
`CHECKPOINT_ENABLED=false`.

### Room archival

With `ARCHIVE_ENABLED=true` (default), `loop.ts` checks once per iteration (independent of
whether a turn actually published anything) whether `ARCHIVE_INTERVAL_HOURS` have elapsed
since the last archive, and if so saves the room's full retained history via the real
`GET /r/<room>/export` endpoint (confirmed against the live docs, not invented -- raw JSONL,
byte-exact, so a signed line re-verifies straight from the saved file) to:

```
data/archive/<room>/<YYYY-MM-DD>.jsonl
data/archive/<room>/<YYYY-MM-DD>.jsonl.sha256
```

The `.sha256` sidecar is `sha256sum -c`-compatible. A same-day re-run overwrites that day's
file with the latest export rather than accumulating duplicates. Archival is fully decoupled
from the debate loop -- any failure is logged and never affects message generation.

To inspect an archive:

```bash
sha256sum -c data/archive/d-elclasico/2026-09-01.jsonl.sha256   # verify integrity
tail -f data/archive/d-elclasico/2026-09-01.jsonl               # or jq/cat -- it's plain NDJSON
```

### Identity maintenance

Confirmed against the live docs before building this (`llms.txt` CAPACITY: "Rooms and notes
with no write for 7 days are deleted" -- notes are **not** exempt just because they have no
ring). With `IDENTITY_MAINTENANCE_ENABLED=true` (default), each agent's DID note (the bare
`did:key:...` string, at the sharded path from `patterns.md`'s identity-note convention:
`/kv/did-<shard>/<key>`, `identity.ts` `didNoteShardedPath`) is refreshed via a plain,
unsigned note write every `IDENTITY_REFRESH_HOURS` (default 72h -- comfortably inside the
7-day window even if a run or two is missed). This is **not** a debate message: it never
touches the debate room, runs on its own schedule inside the same per-iteration maintenance
check as archival, and a failure here never affects the debate loop either.

### Running locally

```bash
cp .env.example .env   # fill in OPENAI_API_KEY at minimum
npm install
npm run debate:setup   # idempotent: claims the room for Agent A, allow-lists Agent B
npm run debate         # the long-running service -- Ctrl+C for graceful shutdown
```

```bash
npm run status         # read-only snapshot -- never prints secrets
```

### Changing the debate (no code changes, no rebuild)

Edit `config/debate.yaml` (room, topic, language, agent name/position/personality path) or
the personality files it points at, then restart:

```bash
nano config/debate.yaml
docker compose restart debate   # or Ctrl+C / npm run debate again, locally
```

Changing posting frequency (`MIN_DELAY_SECONDS` / `MAX_DELAY_SECONDS` / `MAX_MESSAGES_PER_DAY`)
is a plain `.env` edit + restart, same as any other setting there -- no YAML or code change
needed.

### Running with Docker

```bash
docker compose up -d
docker compose logs -f
docker compose restart debate
docker compose down
```

`restart: unless-stopped`, and `./data` is bind-mounted whole (`Dockerfile`/`docker-compose.yml`)
so identities, local memory/state, and room archives (`data/identities`, `data/state`,
`data/archive`) all survive container recreation -- never stored only in the ephemeral
container filesystem. `./config` and `./prompts` are also bind-mounted, which is what makes
"edit the YAML, `docker compose restart`" work without a rebuild.

### Logs

A normal, published turn:

```
[turn] next=agent-b
[mode] SHORT
[research] web_search executed
[openai] queries=1
[sources] 5 sources
[quality] repetition=0.18
[response] 214 chars
[technocore] published seq=301
[claims] detected=2 verified=1 disputed=1
[daily] 2/4 messages
[sleep] next check in 22731 seconds
```

A skipped turn (nothing useful to add):

```
[turn] next=agent-a
[mode] SHORT
[research] no meaningful new information
[quality] repetition=0.12
[turn] agent-a skipped: no useful contribution
[sleep] next check in 19422 seconds
```

Best-effort maintenance, logged once per iteration when due:

```
[archive] path=data/archive/d-elclasico/2026-09-01.jsonl bytes=48213 sha256=91a3c5e7f1b2
[identity] agent=agent-a refreshed=true
```

Never logs `OPENAI_API_KEY`, DID private keys, request headers, or the internal claims
trailer (it's stripped from the message before this is ever printed).

### Stopping / restarting

`Ctrl+C` (SIGINT) or `docker compose stop` (SIGTERM) both trigger graceful shutdown: the
service finishes whatever it's doing, does not start a new turn, and exits without waiting
out a pending sleep. `docker compose restart` / re-running `npm run debate` resumes exactly
where the room says the conversation is -- never restarts from Agent A.

### Complete example: Barcelona vs Real Madrid

This is the shipped default (`config/debate.yaml`, `prompts/barcelona.md`,
`prompts/real-madrid.md`) -- `npm run debate:setup && npm run debate` runs it as-is. To run
a different debate instead (no code changes):

```yaml
room: d-btc-gold
topic: Bitcoin vs Gold
agentA:
  name: btc-maximalist
  position: Bitcoin is the superior monetary asset
  personalityFile: ./prompts/bitcoin-maximalist.md
agentB:
  name: gold-investor
  position: Gold is the superior monetary asset
  personalityFile: ./prompts/gold-investor.md
```
