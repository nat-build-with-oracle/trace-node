# DESIGN — trace-node

Written 2026-09-03 for digger-node; inherited by trace-node at the fork
(`ff5b5cd`, see `NOTICE`). Decisions and their reasons, including the ones
deferred. The trace layer's own decisions live in `ψ/lab/01-trace-node/PRD.md`.

## Why Drupal's shape

Nat's brief: *"we should design like drupal — just have title body datetime, then
we have taxonomy."* That is a good instinct and worth stating why.

Drupal's node/taxonomy model survived twenty years because it separates **the
thing** (a node: title, body, when) from **what the thing is about** (terms in
vocabularies), and refuses to let the second one become schema. Adding a
"category" in most CMSes is a migration; in this model it is a row. That property
is exactly what a model-facing store needs, because an agent inventing a new
vocabulary mid-conversation must not require a deploy.

What we deliberately did **not** take from Drupal: fields, entities, bundles,
revisions, view modes, the render pipeline. Those are what Drupal grew *after*
the part that was right.

## Taxonomy: what Drupal actually does, and what the first cut got wrong

Researched properly after the first version shipped, and it changed the schema.

**Drupal has TWO kinds of vocabulary, and the difference is a policy, not a
display option** ([drupal.org/node/370160](https://www.drupal.org/node/370160),
[Drupal User Guide 6.5](https://www.drupal.org/docs/user_guide/en/structure-taxonomy.html)):

| | free-tagging | controlled |
|---|---|---|
| who adds terms | the author, inline, on the fly | someone deliberate, in advance |
| unknown term | created | **refused** |
| shape | many, specific, flat | few, broad, hierarchical |
| Drupal name | "tags" | "categories" |

The first cut here made *everything* free-tagging. That is the permissive
default and the wrong one for a store a **model** writes to: an LLM tagging the
same concept twice produces `mcp`, `MCP` and `model-context-protocol` — three
rows, one idea, and a taxonomy that has silently stopped being able to answer
"show me everything about X". Nothing errors; the corpus just quietly rots.

So `vocabularies.kind` exists, and `node_tag` into a controlled vocabulary fails
with the list of real terms attached:

```
"Enginering" is not a term in the controlled vocabulary "section".
Available: Engineering, Field notes, Archive.
Add it deliberately with term_create, or use a free-tagging vocabulary.
```

An error a model can act on beats a synonym it will never notice. Note also that
`vocabulary_create` never *re-kinds* an existing vocabulary — a later permissive
call must not be able to disarm the guard.

## Taxonomy vs menu: why there is no menu table

Drupal keeps menus and taxonomy separate, and the community answer to "how do I
navigate by taxonomy" is the **Taxonomy Menu** module
([drupal.org/project/taxonomy_menu](https://www.drupal.org/project/taxonomy_menu)) —
which *generates* menu entries from terms. The reason they are separate systems
there is historical: menus are hand-ordered link lists that can point anywhere,
taxonomy is classification.

We took the generated half and skipped the second system. `terms.weight` is the
whole mechanism: a controlled vocabulary rendered in weight order **is** the
menu, and there is nothing to keep in step. The page proves the point by
rendering the two kinds differently — categories as an ordered vertical menu,
tags as a flat cloud.

What we gave up by not having a real menu table: a menu cannot contain arbitrary
links (external URLs, a single node, a static page), and it cannot order the
vocabularies relative to each other. If either is ever needed, that is the point
to add one — not before.

## Storage: a port, not an ORM

`src/store/types.ts` is four methods — `all`, `first`, `run`, `batch`. Adapters:
D1 (Worker) and SQLite (bun, tests, future desktop).

An ORM was considered and rejected for one specific reason: it would hide the
FTS5 trigram decision. That decision — see below — is the single most load-bearing
thing in this codebase, and a query builder that abstracts SQLite's dialect would
abstract it away into a `where(...)` call that quietly does the wrong thing on
Thai text. The port keeps the SQL visible in `sql.ts` while still making the
physical backend swappable.

Honest limit: **dialect is not portable.** `INSERT OR IGNORE`, `bm25()`, FTS5
virtual tables — Postgres would need its own `sql.ts`, not just its own adapter.
For a corpus that is SQLite everywhere it currently runs (D1 is SQLite, Tauri
would be SQLite, tests are SQLite), that is the right trade.

## Search: trigram, and saying so when it degrades

FTS5's `unicode61` splits on whitespace. Thai has none between words, so a whole
sentence becomes one token and a search for a word inside it returns **zero rows**.
Measured independently four times across this fleet now (arra-memory-haos,
session-viewer, jsonl-proofs, lance-indexer). It ships as the default here so
nobody rediscovers it a fifth time.

Trigram cannot index needles shorter than 3 characters. Rather than return an
empty result set that looks like "no matches", short queries fall back to a
`LIKE` scan and the response carries `"mode": "like"`. The mode is part of the
answer, not a footnote.

## MCP: hand-rolled, and the protocolVersion trap

No SDK. This is one stateless POST endpoint; the SDK's transport layer manages
sessions we do not want, and pinning it means inheriting version churn on a
Worker that otherwise has one dependency.

The specific failure this avoids: three servers in this fleet answered `initialize`
with **their own** protocol revision instead of the client's. A client speaking a
newer revision connected, listed zero tools, and reported no error on either side.
One instance took four wrong fixes before someone logged a real request and saw
`protocolVersion=2025-11-25` was simply missing from a supported list. So here:
echo the client's version when we know its era, fall back to the newest revision
we *implement* (`2025-11-25`) otherwise, never reject. There is a test for it.

The mirror-image trap: digger-node's list led with `2026-07-28` and answered it
to unknown clients while still speaking the pre-2026 wire format — that revision
has no `initialize` at all (`server/discover`, `_meta` versioning, `Mcp-Method`
headers), so the answer was a lie a modern client would act on. trace-node lists
only what it speaks; a 2026-07-28 client must accept an older server's answer,
so negotiating down is honest and first-class. `2026-07-28` joined the list only
when the whole format shipped (gate 1b-mcp2026, below).

### Dual-era: 2026-07-28 next to 2025-11-25, never mixed

The 2026-07-28 revision is a second wire format, and its compatibility matrix
(research/mcp-2026-07-28-wire.md §4) says a modern client against a legacy
server fails, and a legacy client against a modern server fails — only a
*dual-era* server works with both. So `mcp.ts` is two stacks behind one POST:

- **Routing by presence.** A request whose `params._meta` carries any
  `io.modelcontextprotocol/` key is modern; so is `server/discover` (it exists
  in no other era), and so is an `MCP-Protocol-Version` header naming a modern
  revision with no `_meta` to back it (told `-32602`, not processed as legacy).
  Everything else — a bare `initialize`, a 2025-11-25 client sending the
  2025-06-18 header — is the legacy stack, byte-for-byte gate 1a's: no
  `resultType`, no `_meta`, same error codes, same statuses.
- **The modern stack, in the PRD's order.** `_meta.protocolVersion` and
  `_meta.clientCapabilities` required (400 / `-32602`); `MCP-Protocol-Version`
  must equal the body (400 / `-32020` HeaderMismatch, `data {header, expected,
  got}`), and name a revision the modern stack speaks (400 / `-32022`, `data
  .supported` — that error *is* the negotiation for an unlisted modern client);
  `Mcp-Method` must equal `method`, `Mcp-Name` must equal `params.name`/`uri`
  on `tools/call`, `resources/read`, `prompts/get` (the `=?base64?…?=` sentinel
  is decoded first). Then the method: `server/discover` (a `DiscoverResult`),
  `ping`, `tools/list` (a `CacheableResult`: `ttlMs` 3600000, `cacheScope`
  public — the catalogue is a constant of the binary), `tools/call`; anything
  else, `initialize` included, is 404 / `-32601`. Every result carries
  `resultType: "complete"` and echoes `serverInfo` in `_meta`.
- **Errors.** `MCP_ERRORS` is the renumbered table: `-32020…-32022` in the new
  reserved range, resource-not-found at `-32602`. `-32021` and `-32002` are
  named and never emitted — no tool needs a client capability and no resources
  are served — so nobody re-allocates them.
- **Version lists.** `LEGACY_PROTOCOL_VERSIONS` answers `initialize` (a legacy
  client asking for 2026-07-28 hears 2025-11-25: it sent `initialize`, so it
  cannot speak the format it named); `MODERN_PROTOCOL_VERSIONS` is what
  `server/discover` advertises and `-32022` names; `IMPLEMENTED_PROTOCOL_VERSIONS`
  is both, 2026-07-28 first, and nothing answers from it directly.
- **Not done here.** CORS `allow-headers` still lists only `authorization,
  content-type, mcp-protocol-version`; a browser-origin modern client would
  also need `mcp-method` and `mcp-name`. Left for the lead — it flips an
  inherited exact assertion. No `subscriptions/listen`, no `Mcp-Param-*`
  mirroring (no tool schema carries `x-mcp-header`).

## The call log

`mcp_calls` records tool, input, outcome, result, duration and client label for
**every** call including failures. Truncated at 4000 chars at *write* time, so a
runaway argument blob cannot fill the database and only get trimmed on read.

Writes are best-effort and swallowed on failure: an audit trail that can take
down the thing it audits is worse than no audit trail.

This is what makes the server inspectable rather than trusted. It is also the
data a desktop client would render as its main screen.

## Auth: opt-in, three keys, and one gate

Authentication is off until a secret exists, and which state a deployment is in
is reported by `/health` on every call rather than left to be inferred.

The earlier version of this document argued that a bearer token was the wrong
*middle* step, because claude.ai — the client that actually needs auth — cannot
send a static header, so a token secures the server against every client except
the one that motivated the feature. That reasoning was right about sequencing and
wrong as a permanent conclusion. Once OAuth exists, a static token costs almost
nothing and serves a real population the OAuth dance does not: curl, Claude Code,
scripts, and the desktop client `store/sqlite.ts` exists for. So there are three
keys, and they are three because no single mechanism reaches all three callers:

| Key | Caller | Why the others do not work |
|---|---|---|
| `oauth` | claude.ai | cannot send a static header at all |
| `api-token` | curl, Claude Code, Tauri | reads a config file; the dance is ceremony |
| `owner-session` | the browser | cookies, because script-held tokens are XSS-readable |

All three land on the same corpus with the same rights. Scopes are recorded on
the token because the spec asks for them and are deliberately **not** enforced as
a permission split: one owner does not need protecting from itself, and a
permission system nobody exercises is a bug farm rather than a boundary.

### Open by default, and why that is not laziness

With neither secret set, anyone who can reach the URL can read and write. That is
the deliberate first-run state for a one-click install: a deploy button that
produces a Worker returning 401 to its own owner, with no screen on which to set
a secret, is a broken install. The cost is real, so it is stated in three places
— `/health`, the README, and the lock screen's absence — rather than hidden in
one.

### D1, not KV

The Cloudflare-native answer is `@cloudflare/workers-oauth-provider` over a KV
namespace. It was not taken. The provider assumes it owns the fetch handler and
its `apiRoute` gate fires before any JSON-RPC is parsed, which forecloses ever
serving `initialize` and `tools/list` unauthenticated; its `unwrapToken()` also
rejects anything that is not its own three-part token, so the static-token path
would need a separate branch ahead of it anyway. Against that, three tables in
the database that is *already provisioned* cost one migration and add no binding
the deploy button can fail to create.

### An Elysia plugin, and the scope trap it hides

The gate, the OAuth endpoints and the login are one `.use()` — `authPlugin()` in
`src/auth-plugin.ts`. Half of this feature is worse than none: discovery
documents and a token endpoint with nothing actually guarded is a server that
advertises security it does not have. A plugin makes that combination impossible
to assemble by accident.

The trap that shape introduces is worth recording, because it is silent and it
was measured here rather than reasoned about. **An Elysia lifecycle hook declared
inside a plugin is local by default**: it runs for routes declared in the plugin
and not for routes in the parent that mounted it. A default-scoped gate therefore
protects the OAuth endpoints — which need no protection — and leaves `/mcp` and
every `/api` route wide open, with no error anywhere. Hence
`.onBeforeHandle({ as: "global" }, …)`, and hence a test that asserts a **parent**
route 401s. Removing `as: "global"` fails 7 tests; without that test it would
fail none.

### The four silent failures, all guarded by tests

1. **`issuer` not byte-identical** to the origin the client reached. Breaks every
   OAuth client while the static-token path keeps working.
2. **A 401 without the `WWW-Authenticate: … resource_metadata=…` pointer**, or
   with it un-exposed to CORS. The client never learns OAuth exists.
3. **Refusing a bad `redirect_uri` by redirecting to it** — reintroducing the
   open redirect the exact-match check exists to prevent.
4. **Auth checked inside a tool** rather than at the HTTP layer. A 200 wrapping
   `isError: true` never triggers an auth prompt; the model reads "please sign
   in" as text and carries on.

Verified live on workerd, not merely unit-tested: DCR → consent → code → token →
`initialize`, plus a replayed code refused, a wrong passphrase refused, the
static token accepted, and an anonymous call refused.

## Deferred / next

1. ~~**OAuth for claude.ai**~~ — **BUILT** (2026-09-04). Remaining, in order of
   value: **CIMD** (client ID metadata documents — the 2026-07-28 spec's
   replacement for DCR; needs `client_id_metadata_document_supported: true`
   *and* the `global_fetch_strictly_public` compatibility flag, and is silently
   ignored if only one is present), audience-checking the recorded `resource` on
   use, and a token-sweep cron.
2. **Tauri desktop client** — the reason `store/sqlite.ts` exists already. The
   JSON API (`/api/*`) is shaped as the client contract: a desktop build would
   either call a deployed Worker over HTTP or open a local SQLite file through
   the same repository code, with the same MCP handlers, and get a local-first
   app for free. Nothing in `db.ts`, `sql.ts`, `mcp.ts` or `app.ts` would change.
3. **Node revisions** — Drupal's other good idea; `Nothing is Deleted` argues for
   it. Would be an `node_revisions` table plus a `revision_of` column, not a
   rewrite.
3b. **A real menu table**, if arbitrary links or cross-vocabulary ordering are
   ever needed. Deliberately not built — see "Taxonomy vs menu" above.
4. ~~**Embeddings / semantic search**~~ — **BUILT** (2026-09-03), following the
   prescription the measurements implied rather than the default everyone picks.
   See "Semantic search" below.
5. **Multi-user** — there is none. One owner, one corpus, one token.

## Semantic search, built to the measurements

Added on request, and shaped by `ψ/ralph/embedding-benchmark-nlembed.md` rather
than by what is conventional:

- **A separate, explicitly-labelled mode.** `mode="text"` stays the default
  because it won 0.765 vs 0.099 MRR on known-item retrieval. `mode="hybrid"`
  exists but is opt-in and carries its own warning in the tool description and
  in every response, because measured RRF fusion scored *worse* than pure text.
- **A multilingual encoder** — `@cf/baai/bge-m3` via the Workers AI binding.
  Verified live: a Thai query retrieved English content at 0.471.
- **Vectors in their own table, keyed by SPACE.** `workers-ai:@cf/baai/bge-m3:1024`
  is stored per row and every query filters on it. Two deployments of the same
  model are still two spaces — measured elsewhere in this fleet, and there is a
  test proving a foreign space returns 0 rather than ranking against it.
- **Embedding is a second phase.** `createNode` takes the embedder and embeds
  opportunistically, but a failure never touches the write; `node_embed`
  backfills. A node written while Workers AI is down is a complete node.
- **Coverage travels with the answer**, in `node_search`, `status`, and
  `/api/stats` — the exact gap this dig found in the fleet's own tools.
- **Brute-force cosine, no ANN.** The measured crossover is 2,000-20,000 vectors;
  below it an index costs complexity for nothing. Above it, the honest fix is an
  index, not a bigger loop.

### Two bugs this feature found, both silent

1. **MCP `node_create` did not embed; the REST path did.** The exact defect class
   the dig documented ("a capability only exists where its users are"), which
   `arra-memory` shipped twice in opposite directions. Fixed by moving the
   embedder into `createNode` so there is one call site, with a test asserting
   both doors produce identical coverage.
2. **D1 returns BLOBs as `number[]`, not `Uint8Array`.** `new Float32Array(...)`
   on a number array *copies each byte as a float* rather than reinterpreting
   the buffer — producing a 4096-element vector of small integers instead of
   1024 floats. Nothing throws. Every production cosine sat between -0.03 and
   +0.01, which reads exactly like "nothing in this corpus is related". A wrong
   answer wearing the costume of a right one, live for one deploy. Now branched
   on and locked by a round-trip test across both driver shapes.

## What was verified, and how

- 26 tests, `bun test`, in-memory SQLite through the same app the Worker runs:
  MCP protocol negotiation (including the unknown-version path), node CRUD,
  taxonomy creation/idempotency/filtering, Thai trigram search, the LIKE-fallback
  disclosure, call logging of both successes and failures, and every auth branch.
- `tsc --noEmit` clean.
- **Verified live against real D1** via `wrangler dev --local` (workerd + its own
  SQLite), 2026-09-03: both migrations applied including the **FTS5 trigram
  virtual table** (so D1's SQLite build does have it); `initialize` echoed a
  client-requested `2025-11-25`; a node with a Thai body was created with two
  taxonomy terms; `node_search "ความจำ"` returned `mode: "fts", count: 1` —
  matching a word *inside* a Thai sentence; the call log recorded three successes
  and one deliberate failure with inputs, results and durations; the page rendered.
- **Not verified**: the Deploy-to-Cloudflare button end to end (needs a real
  account), and remote D1 (only `--local` was exercised). Everything above is
  workerd-real but machine-local.

## Two bugs this build found by running it, not by reasoning about it

Both would have passed every unit test and failed on the first production request:

1. **`EvalError: Code generation from strings disallowed`** — Elysia's default
   AOT compiler builds handlers with `new Function()`, which workerd forbids.
   Fixed with `new Elysia({ aot: false })`. `bun test` never sees this because Bun
   allows codegen; only `wrangler dev` does.
2. **Every MCP call returned `-32700 parse error`** while `/health` was fine —
   Elysia had already consumed the request body, so `handleMcp`'s own
   `request.json()` read an empty stream. Fixed by passing the parsed body in
   rather than re-reading the Request.

The lesson is the fleet's own recurring one, in a new costume: a component that
works and a wiring that answers a different question, with nothing throwing at
build time.
