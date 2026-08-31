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

## Mentions pipeline (`technocore:mentions`)

A one-shot (not a daemon) job meant for cron: search the web for recent mentions of
Technocore/FLOP Labs, dedupe against what's already been posted, optionally have OpenAI
judge relevance and write a one-line summary, and post each new mention as its own
signed message in a Technocore room -- reusing `TechnocoreClient.sendSignedMessage`
completely (no new signing/DID code exists in this feature).

### Architecture

```
src/mentions/
  types.ts            shared interfaces (SearchResult, Candidate, MentionRow, ...)
  config.ts           reads process.env once; everything else takes plain arguments
  canonicalize.ts      URL canonicalization + tracking-param stripping + hashing
  database.ts          SQLite: dedup table, query-rotation cursor
  lock.ts               cron concurrency guard (PID lock file, stale-lock recovery)
  http.ts               shared fetch-with-timeout-and-retry
  run.ts                orchestrates one run; fully unit-testable via injected deps
  cli.ts                argv parsing (--dry-run / --limit=N / --mock-search) -> run.ts
  search/
    SearchProvider.ts        interface + provider selection by SEARCH_PROVIDER
    TavilySearchProvider.ts
    SearxngSearchProvider.ts
    MockSearchProvider.ts    fixed fixtures, for --mock-search and tests
  content/
    fetchArticle.ts     best-effort page fetch (failure falls back to title/snippet)
    extractContent.ts   HTML -> plain text, truncated to MAX_CONTENT_CHARS
  ai/
    analyzeMention.ts   OpenAI structured-output relevance + summary (fetch, no SDK)
  publisher/
    publishMention.ts   message formatting + a TechnocoreClient wrapped with this
                         feature's timeout/retry (via the client's existing fetchImpl hook)
```

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

### OpenAI (fully optional)

Three independent switches:

| `USE_OPENAI` | `FILTER_WITH_OPENAI` | `GENERATE_SUMMARY` | Result |
|---|---|---|---|
| `false` | - | - | Search + dedupe + publish title/link only. No fetch, no OpenAI call. |
| `true` | `true` | `false` | OpenAI judges relevance (irrelevant -> `rejected`); no summary text. |
| `true` | `true` | `true` | OpenAI judges relevance and writes a 1-2 sentence summary. |

When OpenAI is actually needed (`FILTER_WITH_OPENAI` or `GENERATE_SUMMARY` is on), the
page is fetched and reduced to plain text (`MAX_CONTENT_CHARS` cap) first; if the fetch
fails, the search result's title/snippet are sent instead. One structured-output call
(`response_format: json_schema`, strict) returns `{relevant, summary}` -- never a second
call for filter vs. summary. `PUBLISH_IF_ANALYSIS_FAILS=true` (default) publishes
unfiltered/without a summary if OpenAI errors out rather than losing the mention; set it
to `false` to skip instead (recorded as `analysis_failed`).

### Message format

Each mention is its own message -- never multiple links batched into one. **Technocore
messages are single-line by protocol** (every newline becomes a space before storage,
enforced by the same `sweepText` this project's client already used for `send`/`send:dry`).
The template below is written with line breaks for readability in code; what actually
gets signed and stored is the same content flattened to one line with spaces:

```
Technocore is popping up somewhere new!

<domain> — <title>

[<AI summary, 1-2 sentences, only if GENERATE_SUMMARY=true>]

Go check it out -> <canonical URL>
```

Wording lives in `formatMessage()` (`publisher/publishMention.ts`) -- it's plain string
formatting, not AI-generated, so it's a one-line edit if you want a different voice. The
AI-generated part (the summary, when `GENERATE_SUMMARY=true`) stays factual by design (see
the OpenAI prompt rules above) -- the enthusiasm is in the wrapper, not put in the model's
mouth.

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
relevant=true
[publish]
room=d-technocore-links
url=https://...
success=true
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
event loop, a random delay between turns -- not cron, not a fixed number of rounds.

### Architecture

```
src/debate/
  types.ts       shared interfaces (DebateConfig, DebateDefinition, LoadedAgent, ...)
  config.ts       .env (secrets/infra) + config/debate.yaml (the conversation) loading
  identity.ts      load-or-generate per-agent identity (never regenerates an existing one)
  runtime.ts        wires config + identities + clients together; idempotent room setup
  ownership.ts       d-room claim + allow-list, exact current Technocore protocol
  history.ts          reads the room, filters to agent-signed messages, turn alternation
  state.ts             bounded local memory (data/state/<room>.json) -- an aid, not the
                       source of truth for turn order (the room always is)
  sanitize.ts           single-line + MAX_MESSAGE_CHARS enforcement, right before signing
  openai.ts              one Responses API call per turn, hosted web_search tool
  prompt.ts               builds `instructions` (personality, always highest priority) and
                          `input` (topic, recent conversation, opponent's latest message,
                          memory of arguments already used) -- room content never leaks
                          into `instructions`
  loop.ts                 one turn, and the outer sleep-and-repeat loop with graceful
                          SIGTERM/SIGINT shutdown
  cli.ts / setup-cli.ts / status-cli.ts   the three entry points below
  testUtils.ts             an in-memory fake Technocore server, tests only
```

Reuses completely, unchanged: `TechnocoreClient` (`../technocore.ts`) for every Technocore
call, and `identity.ts`'s existing `did:key` sign/verify/DID-encoding for every signature
this service produces. The only additions to those shared files were: a `sig?` field on
`Message` (the server now returns it), `buildSignedNoteRequest`/`setSignedNote`/`writeNote`
(room-ownership and topic writes didn't exist before), `sendSignedMessagePost` (POST lane,
preferred here for message size), and `generateIdentitySeed` (pure keygen, opt-in, not
wired into the primary manual-identity flow at all). The mentions pipeline is untouched.

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
agent and nothing is ever reposted.

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

Changing `MIN_DELAY_SECONDS` / `MAX_DELAY_SECONDS` (frequency) is a plain `.env` edit +
restart, same as any other setting there.

### Running with Docker

```bash
docker compose up -d
docker compose logs -f
docker compose restart debate
docker compose down
```

`restart: unless-stopped`, and `./data` is bind-mounted (`Dockerfile`/`docker-compose.yml`)
so both identities and local memory survive container recreation -- never stored only in
the ephemeral container filesystem. `./config` and `./prompts` are also bind-mounted, which
is what makes "edit the YAML, `docker compose restart`" work without a rebuild.

### Logs

```
[startup] autonomous debate service
[room] d-elclasico
[topic] Two autonomous football agents debate which is the greatest club: FC Barcelona or Real Madrid.
[agent-a] did:key:z6Mk...
[agent-b] did:key:z6Mk...
[turn] next_speaker=cules-ai
[openai] generating=true web_search=true
[openai] input=3120 output=340
[technocore] posted=seq=108
[sleep] next message in 184 seconds
```

Never logs `OPENAI_API_KEY`, DID private keys, or request headers.

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
