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
