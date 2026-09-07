# trace-node

> **Fork note.** trace-node is forked from
> [Soul-Brews-Studio/digger-node](https://github.com/Soul-Brews-Studio/digger-node)
> @ `ff5b5cd` (see `NOTICE` and `package.json` `forkedFrom`). This README is the
> inherited digger-node README with names updated; the code, the `digger-node`
> strings inside it, and the 16 screenshots under `docs/images/` are digger's
> and show digger's UI until they are regenerated at gate 2. The trace layer
> that gives this fork its name is described in `ψ/lab/01-trace-node/PRD.md`.

A **Drupal-shaped content store** — title, body, datetime, taxonomy — that a model
talks to over **MCP**, running on one Cloudflare Worker with one D1 database.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Soul-Brews-Studio/digger-node)

One click provisions the D1 database, runs the migrations, deploys the Worker, and
clones the repo into your own GitHub account so every later push redeploys itself.

[![The digger-node web UI](docs/images/03-home.png)](docs/README.md)

*Every screenshot in this repo is a real running instance — real corpus, real
OAuth flow, real error strings. [Take the tour](docs/README.md).*

---

## The content model, in four nouns

Drupal got this part right in 2004 and most tools have been re-inventing it worse
ever since:

| Noun | What it is |
|---|---|
| **node** | One piece of content: `title`, `body`, `created_at`, plus a free-text `type` and a published flag |
| **vocabulary** | A namespace for terms, *with a policy* — see below |
| **term** | A label inside a vocabulary, nestable via `parent_id`, ordered by `weight` |
| **node_terms** | The join: a node wears any number of terms |

### Tags vs categories — the distinction worth copying

Drupal ships two kinds of vocabulary, and it is a policy rather than a display
option:

```
kind: "tags"        free-tagging  → unknown terms are CREATED on demand
                                    many, specific, flat  (tags, topics)

kind: "categories"  controlled    → unknown terms are REFUSED
                                    few, broad, stable    (section, status)
```

The controlled kind is the guard that matters when a **model** does the tagging.
Ask an LLM to file the same idea twice and you get `mcp`, `MCP` and
`model-context-protocol` — three rows, one concept, and a taxonomy that has
quietly stopped answering "everything about X". Nothing errors. With a
controlled vocabulary it errors usefully instead:

> `"Enginering" is not a term in the controlled vocabulary "section". Available: Engineering, Field notes, Archive. Add it deliberately with term_create, or use a free-tagging vocabulary.`

### The menu is the taxonomy

Drupal keeps menus separate from taxonomy and bridges them with the *Taxonomy
Menu* module. We kept the bridge and skipped the second system: `terms.weight`
orders a vocabulary, so **a controlled vocabulary rendered in weight order is
the menu** — with nothing to keep in step. The site renders categories as an
ordered menu and tags as a cloud, which is the distinction made visible.

That is the whole schema. It is enough to be a blog, a wiki, a bug tracker, a
reading list, or a field notebook — the difference between those is which `type`
strings and which vocabularies you happen to use, not a migration.

## Nineteen MCP tools

```
node_create  node_get  node_update  node_delete  node_list  node_search
node_tag     node_untag  node_embed  node_types
vocabulary_create  vocabulary_list  term_create  term_list  term_weight
call_log     call_stats            status
```

### Selecting by tags — one, many, AND or OR

```jsonc
// at least one of these tags (default)
{ "terms": ["topics:mcp", "tags:bangkok"], "match": "any" }
// every one of them
{ "terms": ["topics:mcp", "tags:bangkok"], "match": "all" }
// by id instead of name
{ "term_ids": ["term_abc", "term_def"], "match": "all" }
```

Over REST: `?terms=topics:mcp,tags:bangkok&match=all`.

The response echoes the `match` that actually ran, because "all" quietly
behaving as "any" is a filter bug you only notice as a wrong answer. Two things
this gets right that are easy to get wrong:

- **`match: "all"` is a `GROUP BY … HAVING COUNT`, not a `WHERE`.** Written as a
  WHERE it returns *nothing*, because no single join row can equal two terms.
- **A tag that does not exist returns nothing, not everything.** Resolving zero
  ids and then falling through to the unfiltered query would answer "nodes
  tagged X" with the entire corpus. There is a test for it.

### Managing content types

Types are **derived** — `node_types` reports what is in use with counts, and a
type exists because a node names it. There is no registry to maintain and
nothing to keep in step.

That is the permissive default, and it has the same drift problem free tags do:
a model will happily write `note`, `Note` and `notes`. So the lock is the
taxonomy machinery you already have, not a second system:

```jsonc
vocabulary_create { "name": "type", "kind": "categories" }
term_create       { "vocabulary": "type", "name": "article" }
```

With a controlled vocabulary named `type`, `node_create` and `node_update`
refuse anything not on the list — and say what is:

> `"aritcle" is not an allowed content type. Available: article, note. Add it with term_create{vocabulary:"type"}, or delete the controlled "type" vocabulary to allow free text.`

`node_types` reports `policy: "free" | "controlled"` so the state is never a guess.

### Three search modes, and why the default is the boring one

```
mode="text"      (default)  trigram index — matches inside Thai words, 7ms
mode="semantic"             bge-m3 via Workers AI — finds what you DESCRIBE
mode="hybrid"               RRF k=60 — opt-in, and measured worse than text
```

Measured on this fleet's own corpus (n=200, 124k blocks): text scored **0.765
MRR** for known-item retrieval, semantic **0.099**, and hybrid **0.437** — equal-
weight fusion lets a confident-but-wrong neighbour list drag down a confident-
and-right lexical one. So text is the default and hybrid is never automatic.

Semantic earns its place on the *other* question. Live on this deployment:

| query | text | semantic |
|---|---|---|
| "why do we split words differently for other languages" | **0 hits** | "Why trigram, not unicode61" · 0.545 |
| "การจัดหมวดหมู่เนื้อหา" (Thai) | — | "Categories vs tags" · 0.471 |

That second row is the reason the model is multilingual: a Thai query finding
English content. MiniLM-class encoders are blind to Thai and would return noise.

Every response reports the mode that ran and, for semantic, coverage
(`"4/4 nodes embedded"`) — because a low score from an un-embedded row is a
coverage fact, not a ranking result, and this fleet has misread that before.

Tagging takes `"vocabulary:term"` strings and creates whatever is missing, so a
first call needs no setup:

```json
{ "title": "Bangkok flood sensors", "body": "…", "terms": ["topics:iot", "tags:bangkok"] }
```

### The call log is a first-class table

Every tool call is recorded with its **arguments, outcome, result and duration** —
successes and failures both. `call_log` and `call_stats` expose it over MCP, the
web page renders it live, and `/api/calls` serves it as JSON.

An MCP server you cannot watch is one you are trusting on faith: "the model said
it saved that" is not evidence a row exists. Now you can check.

## Screenshots

A visual tour of every screen — the site, the untagged queue, Thai trigram
search, tag filtering, the lock screen and the OAuth consent page — is in
**[`docs/`](docs/README.md)**. For the connector flow specifically, see
**[docs/connect-claude-ai.md](docs/connect-claude-ai.md)**.

[![The digger-node web UI](docs/images/03-home.png)](docs/README.md)

## Connect it

**Claude Code**

```bash
claude mcp add --transport http digger-node https://<your-worker>.workers.dev/mcp
```

**Anything else that speaks streamable HTTP MCP** — point it at `POST /mcp`.

**claude.ai** — Settings → Connectors → Add custom connector, paste the `/mcp`
URL. Set `OWNER_PASSPHRASE` first (below): claude.ai registers itself, sends you
to an approval page, and you type the passphrase once.

**curl, or anything that reads a config file** — send `Authorization: Bearer
$API_TOKEN`.

## Auth is opt-in, and the server says which state it is in

With **no secrets set the server is open**: anyone who can reach the URL can read
and write the whole corpus, and `/health` reports `"auth": "none"` so it is never
a guess. That is the deliberate first-run state for a one-click deploy — a button
that produces a Worker returning 401 to its own owner, with no screen on which to
set a secret, is a broken install.

Turn it on with either secret, or both:

```bash
# OAuth for claude.ai, plus the web login. One passphrase is the whole account system.
wrangler secret put OWNER_PASSPHRASE

# A static bearer for curl, Claude Code, scripts, a desktop client.
wrangler secret put API_TOKEN
```

`/health` then names the doors rather than saying "on":

```json
{ "auth": ["api-token", "oauth", "owner-session"] }
```

That specificity matters: `"auth": true` on a server where only `API_TOKEN` is
set would read as "claude.ai can connect", which it could not.

### The passphrase has a guessing budget

Every other secret here has real entropy — a 32-byte token, a PKCE verifier, a
single-use code burned on the first failed exchange. The owner passphrase is the
one a *human* chose, and `/login` and `/authorize` were willing to be asked about
it without limit. On a `*.workers.dev` hostname, which is world-reachable the
moment it exists, that is what turns a short passphrase from "weak" into "falls
this afternoon". The crypto was never the weak link; the budget was.

Five wrong guesses per address per door, then backoff: 2m, 4m, 8m … capped at an
hour, so a mistake is always recoverable by waiting rather than by redeploying. A
correct passphrase clears the record, and `/login` and `/authorize` have separate
budgets. The throttle gates the **attempt**, not the verdict — a locked-out caller
holding the right passphrase still gets a 429, or the lockout would tell them the
moment they hit it.

It is **not a perimeter**: it keys on `CF-Connecting-IP`, so many addresses means
many budgets and a shared NAT gives many users one. It converts an unlimited
online guessing attack into a limited one. A long passphrase is still the real
defence; this buys the time to have chosen one.

**Optional**, and off is a legitimate answer — behind Cloudflare Access, on a
private network, or with a 40-character passphrase it buys nothing and costs a D1
write per failed attempt:

```bash
wrangler secret put RATE_LIMIT   # or a var: "off" / "false" / "0" / "no"
```

On by default whenever auth is on, because the deployment that most needs a
guessing budget is the one nobody configured. `/health` reports `rate_limit:
true | false | null` (null = open server, nothing to protect). It fails **open**:
if the store errors the attempt proceeds, because failing closed would let a
transient database fault lock you out of your own corpus through the only door
that could fix it.

### Three keys, one gate

| Key | Who it is for | Why nothing else works for them |
|---|---|---|
| **oauth** | claude.ai connectors | They cannot send a static header at all. OAuth is the only door. |
| **api-token** | curl, Claude Code, scripts, Tauri | They read a config file. The OAuth dance would be ceremony with no benefit. |
| **owner-session** | the web page | A browser has cookies and cannot hold a bearer token without script keeping it somewhere an XSS could read. |

All three open the same corpus with the same rights. The distinction is how the
caller proved it is the owner, not what it may then do.

### What the OAuth actually is

OAuth 2.1: authorization code + **PKCE S256 only** (`plain` is refused at issue
time, not merely unadvertised), **Dynamic Client Registration** because claude.ai
registers itself, and the two discovery documents a client needs to find any of
it. Codes live 10 minutes and are single-use; tokens live 30 days; there are no
refresh tokens and no client secrets. Storage is three tables in the D1 database
that is already bound — **no KV namespace**, because every added binding is one
more thing the deploy button can fail to provision.

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource/mcp` | RFC 9728 — what a client reads first, from the 401's `WWW-Authenticate` |
| `GET /.well-known/oauth-protected-resource` | the bare variant, because clients ask for it |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 — where `/authorize` and `/oauth/token` live |
| `GET /.well-known/openid-configuration` | the same document again; a client that 404s twice stops looking |
| `POST /oauth/register` | RFC 7591 dynamic client registration (JSON) |
| `GET/POST /authorize` | the approval page — the only human step |
| `POST /oauth/token` | code + verifier → access token (form-urlencoded) |
| `POST /login` `POST /logout` | the browser's cookie session |
| `GET /api/clients` `DELETE /api/clients/:id` | who holds access, and how to take it back |

### The four ways this breaks silently

Every one of these produces "could not connect" with nothing useful in any log,
and each is guarded by a test in `test/auth.test.ts`:

1. **`issuer` not byte-identical to the origin the client reached.** A trailing
   slash or the wrong host fails every OAuth client while the static-token path
   keeps working — a deliberately confusing pair of symptoms. Set `PUBLIC_URL`
   only if a proxy rewrites `Host`.
2. **A 401 without the `WWW-Authenticate: … resource_metadata=…` pointer.** The
   client never learns OAuth exists here. It must also be CORS-exposed, or a
   browser client cannot read the header it was sent.
3. **Refusing an unknown `redirect_uri` *by redirecting to it*.** That is the
   open redirect the exact-match check exists to prevent. Failures stay on our
   own page.
4. **Auth checked inside a tool instead of at the HTTP layer.** A 200 wrapping
   `isError: true` never triggers an auth prompt — the model just reads "please
   sign in" as text and carries on. The gate runs before `handleMcp` is called.

One more that is worth knowing but is not a bug: claude.ai caches discovery
documents **globally by URL for about five minutes**. A metadata fix that appears
not to have worked, thirty seconds after a redeploy, has probably worked.

## Routes

| Route | What |
|---|---|
| `POST /mcp` | The MCP endpoint (JSON-RPC, stateless — no sessions, no SSE) |
| `GET /` | The site: create form, taxonomy nav, tag cloud, search, live call log |
| `GET /health` | Driver, auth shape, tool count, node count — never a secret |
| `GET /api/nodes` `?q=` `?type=` `?terms=` `?match=` `?untagged=1` | Nodes, or search |
| `GET /api/nodes/:id` | One node with its terms |
| `POST /api/nodes` | Create (accepts `terms[]`) |
| `POST /api/vocabularies` `POST /api/terms` | Create taxonomy from the browser |
| `POST /api/nodes/:id/tags` | Tag an existing node |
| `GET /api/terms` `/api/vocabularies` | Taxonomy |
| `GET /api/calls` `/api/calls/stats` | The call log |
| `GET /api/types` | Content types in use + whether the guard is on |
| `GET /api/tools` `/api/stats` | Tool catalogue, corpus shape |
| `GET /api/clients` `DELETE /api/clients/:id` | Who holds OAuth access; revoke one |
| `POST /oauth/register` `/oauth/token` `GET,POST /authorize` | The OAuth flow |
| `POST /login` `POST /logout` | The browser's cookie session |

Everything except `/health`, `/`, the discovery documents and the OAuth flow
itself is behind the gate once a secret is set. The allow-list is one `Set` in
`src/auth-plugin.ts` — a route added later is protected by default.

### The four discovery documents, and why there are four

Always public, even with OAuth switched off — a client that fetches these on an
open server learns the endpoints exist and then gets a 200 from `/mcp` without a
token, which is the truth. Hiding them when unconfigured would make "is OAuth
available here?" unanswerable.

They are not variants of one document. The first two answer questions asked by
**different roles**, and this Worker happens to be both roles at once:

| Route | Spec | Answers |
|---|---|---|
| `GET /.well-known/oauth-protected-resource/mcp` | RFC 9728 | *"I am guarded — here is who guards me."* The **first** thing a client fetches, having been pointed at it by the 401's `WWW-Authenticate` header. |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 | The same document at the bare path. See the note below — this one is a hedge, not a requirement. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | *"I issue tokens — here are my endpoints."* Where `/authorize`, `/oauth/token` and `/oauth/register` are named, and where PKCE support is advertised. |
| `GET /.well-known/openid-configuration` | OpenID Connect Discovery 1.0 | Byte-identical to the RFC 8414 document. **This server is not an OpenID provider.** |

**Why an OAuth server answers at an `openid` path.** OpenID Connect shipped a
discovery endpoint in 2014; OAuth did not standardise its own until RFC 8414 in
2018, which deliberately chose a *different* name so that an authorization server
which is not an OpenID provider does not advertise itself as one. By then every
client already spoke the OIDC path, so it never died. A compliant MCP client
tries RFC 8414 first, falls back to the OIDC name, and **stops looking if both
404** — so serving the same bytes twice is insurance against a discovery chain
that dead-ends, and costs one route.

**Why the bare `oauth-protected-resource` path is a hedge.** RFC 9728 inserts the
well-known segment *between* host and path: for a resource at `https://host/mcp`
the correct metadata URL is `https://host/.well-known/oauth-protected-resource/mcp`.
The bare form is correct only for a resource at the origin **root** — and the
document served there names `/mcp`, which at that URL is slightly untrue. It is
served because clients probe it anyway, and it is safe because RFC 9728 requires
the client to check that `resource` matches what it asked for: a client wanting
`/mcp` is helped, and one wanting the root correctly rejects it. If it never
fires, it should go.

## The web UI

### Who tags: the model, not the person

A human supplies a **title, a body and a type** — the things a human knows.
Nobody should be hand-typing `topics:mcp, tags:bangkok`; classification is what
an agent is good at and what MCP is for.

So in the page, **every tag is a read control**: click one in the sidebar, or
click one printed on a node, to filter by it. The only tag-shaped thing a human
gets is the **untagged queue** — the list of content the model has not reached.

The loop, verified live on this deployment:

```
human   POST /api/nodes            → node with no tags
agent   node_list {untagged:true}  → 3 waiting
agent   node_tag  {id, terms:[…]}  → classified
human   clicks a tag               → finds the agent's work
```

Everything the browser writes goes through the **same endpoints the MCP tools
call** — there is no browser-only path, so a node typed by a human and one
written by a model are identical rows.

- **Create** — title, body, and a type control that follows the policy (a
  dropdown when `type` is controlled, free text when it is not). **It does not
  ask for tags.**
- **Organization** — vocabularies and terms are creatable from the page. A
  controlled vocabulary renders as an ordered **menu** (by weight); a
  free-tagging one renders as a **tag cloud** sized by usage.
- **Filter** — every tag is a read control: click any of them (in the sidebar,
  or on a node itself) to filter, toggle `any`/`all`, and the selection lives in
  the URL (`#/terms/id1,id2/all`) so a view is shareable and survives reload.
- **Untagged** — the queue of content nothing has classified yet, linked from
  the corpus panel and available as `node_list{untagged:true}` so an agent can
  find its own work.
- **Search** — with the mode picker (`text` / `semantic` / `hybrid`), and the
  heading reports the mode that actually ran plus embedding coverage.
- **Errors are shown verbatim**, which is why refusals are worth writing well:
  a controlled vocabulary answers with the terms that *are* allowed.

### The tag cloud sizes by usage, on a log scale

`/api/terms` returns a `usage` count per term (a `LEFT JOIN`, so a term with no
nodes still appears — hiding it would make a fresh vocabulary look broken).
Sizes run 11px→20px on **log** scale: with counts of 1 and 40 a linear map makes
every other tag identically tiny and the cloud stops carrying information, which
is why tag clouds have always used log.

## Versioning

CalVer: **`v{yy}.{m}.{d}`** — `v26.9.4` is 2026-09-04, not "version 26". The
fleet this came from versions the same way.

The reason is honest rather than fashionable: this is a personal tool that ships
whenever something is learned, so a semantic version number would be claiming a
compatibility contract nobody is maintaining. A date says what it actually is —
the state of the thing on the day it was cut. `/health` and the page footer
report it, so a running deployment always names its own build.

Tags before `v26.9.4` are semver (`v0.1.0`, `v0.2.0`); they are left alone rather
than rewritten. CalVer sorts after them, so tooling that expects ordering keeps
working.

## Local

```bash
bun install
bun run test          # 110 tests, in-memory SQLite, no wrangler needed
bun run typecheck
bun run db:local      # apply migrations to the local D1
bun run dev           # wrangler dev
```

> **Run `bun run test`, not bare `bun test`.** The script is pinned to
> `bun test ./test` for a reason. Bun's default test discovery walks the whole
> repo root, and if anything there resolves into a large or symlinked tree — a
> symlink to a notes vault, a sibling checkout — discovery can match **zero**
> files and still **exit 0**. Measured here: a `ψ` symlink at the root turned
> `bun test` into a silent no-op printing only its version banner, while
> `bun test ./test/app.test.ts` ran 63 tests from the same working directory.
> A green exit code with nothing run is worse than a red one, so the path is
> explicit and does not depend on what else is lying around.

## Two things worth knowing

**Search is trigram, on purpose.** FTS5's default `unicode61` tokenizer splits on
spaces, and Thai does not use them — so a Thai sentence becomes one token and
searching a word inside it returns nothing. This fleet has now measured that
independently four times. Queries under 3 characters can't use a trigram index,
so they fall back to a `LIKE` scan and **the response says `"mode": "like"`**.
A search tool that degrades silently is one that lies about its own recall.

**The storage layer is a port, not an ORM.** `src/store/types.ts` defines four
operations; `store/d1.ts` and `store/sqlite.ts` implement them. The repository,
the SQL and the MCP handlers never see D1 — which is why the test suite runs the
*identical* code against in-memory SQLite, and why a Tauri desktop build can run
it against a local file. What is deliberately *not* abstracted is SQL dialect:
the statements are SQLite-flavoured, and moving to Postgres means a second
statement file, not just a second adapter.

## Layout

```
src/
  index.ts        Worker entry — the only file that knows about D1
  app.ts          Elysia routes, built from a Store
  mcp.ts          MCP JSON-RPC + the tool catalogue
  db.ts           Repository — no SQL text, no D1 types
  sql.ts          Every statement, as named constants
  utils.ts        Ids, slugs, clamps, FTS quoting, token crypto
  page.ts         The one HTML page
  auth-plugin.ts  The gate + OAuth + login, as one Elysia plugin
  auth.ts         One gate, three keys — which one opened it
  oauth.ts        OAuth 2.1 AS: DCR, PKCE, codes, tokens
  session.ts      The browser's signed cookie (no session table)
  screens.ts      The consent and lock screens — deliberately JS-free
  store/          The port and its adapters (d1, sqlite)
migrations/       0001 schema · 0002 embeddings · 0003 oauth
test/             The whole stack against in-memory SQLite
```

MIT. Part of [digger-oracle](https://github.com/Soul-Brews-Studio/digger-oracle)'s `ψ/lab`.
