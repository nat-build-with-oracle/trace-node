/**
 * The HTTP surface, as an Elysia app.
 *
 * The app is built by a FUNCTION that takes a Store, not by a module that
 * reaches for a global. That is what keeps the same routes usable in three
 * places: a Worker hands it a D1-backed store, `bun test` hands it an in-memory
 * SQLite one, and a desktop build would hand it a file on disk. Nothing in this
 * file knows which it got.
 *
 * Elysia here is doing routing and validation, not architecture: every handler
 * is a few lines that calls the repository and returns plain JSON.
 */

import { Elysia, t } from "elysia";

import { authenticate, authEnabled, authModes, isOwnerCaller, type AuthConfig } from "./auth";
import { authOf, authPlugin, callerFor, INGRESS_REFUSALS, ingressDeniedResponse, ingressRefusedResponse } from "./auth-plugin";
import * as db from "./db";
import { handleMcp, resolveTermRefs, seesPrincipals, TOOLS } from "./mcp";
import { page } from "./page";
import { readStored } from "./passphrase";
import { loginPage } from "./screens";
import * as connections from "./connections";
import { categoryOf, findCategoryTerm, listCategories, tagCloud, traceOf, traceVisibility } from "./cloud";
import { dig, DigBudgetExceeded, listDigs } from "./dig";
import { DEFAULT_RETENTION, readHousekeeping } from "./janitor";
import {
  countDigs,
  countTraces,
  FORGET_TOOL,
  forgetKeyword,
  listTraces,
  surfaceOf,
  traceCategory,
  traceRead,
  traceSearch,
  traceTermList,
} from "./trace";
import { fromIngress, ingressBase, parseCidrs, remoteAddress, type Clock } from "./utils";
import { VERSION } from "./version";
import type { Embedder } from "./embed";
import type { Store } from "./store/types";

export interface AppOptions {
  store: Store;
  instanceName?: string;
  version?: string;
  /** Optional by contract. Absent = text search only, and /health says so. */
  embedder?: Embedder | null;
  /** Optional by contract. Absent = open server, and /health says that too. */
  auth?: AuthConfig;
  /** Overrides the origin advertised in OAuth metadata. Only needed behind a
   *  proxy that rewrites Host — see oauth.ts on why this must be exact. */
  publicUrl?: string;
  /** Throttle the passphrase endpoints. Defaults ON whenever auth is on. */
  rateLimit?: boolean;
  /**
   * One clock, not a Store method (PRD §3.2). Every `at` column, every window
   * and every expiry comparison reads it; tests pass one and advance it.
   */
  clock?: Clock;
  /**
   * What the janitor is configured to keep (PRD §3.8), reported by
   * /api/health. The janitor itself is started by server.ts — the app never
   * owns a timer, so `bun test` never has one to leak.
   */
  retention?: { traceDays?: number; callsDays?: number };
}

/** The cap on every non-/mcp request body (PRD §3.3). */
export const MAX_JSON_BODY = 64 * 1024;

/** What a browser may send us cross-origin (PRD §5.4, extended at 1b-3 for §8.1b (3)). */
export const CORS_ALLOW_HEADERS = "authorization, content-type, mcp-protocol-version, mcp-method, mcp-name";

class PayloadTooLarge extends Error {
  constructor(declared: number) {
    super(`request body of ${declared} bytes exceeds the ${MAX_JSON_BODY}-byte limit`);
  }
}

/**
 * Authentication is OPT-IN, and which state a deployment is in is never left to
 * be inferred.
 *
 *   no secrets set        the server is open — anyone who can reach the URL can
 *                         read and write. /health says `"auth": "none"`, and the
 *                         page says so on its face.
 *   API_TOKEN set         a static bearer works. For curl, Claude Code, a Tauri
 *                         client — anything that can send a header.
 *   OWNER_PASSPHRASE set  OAuth 2.1 + PKCE + DCR is live, which is the only door
 *                         claude.ai can walk through, and the browser gets a
 *                         cookie session behind the same passphrase.
 *
 * Open-by-default is a deliberate choice for a one-click install, not laziness:
 * a deploy button that produces a Worker returning 401 to its own owner, with no
 * screen on which to set a secret, is a broken first run. The cost is real, so
 * it is stated in three places rather than hidden in one.
 */
export function createApp({
  store,
  instanceName = "trace-node",
  version = VERSION,
  embedder = null,
  auth = {},
  publicUrl,
  rateLimit,
  clock = () => new Date(),
  retention = {},
}: AppOptions) {
  const guarded = authEnabled(auth);
  const throttled = rateLimit ?? guarded;
  const trusted = parseCidrs(auth.trustedProxies);
  const retentionDays = {
    trace_days: retention.traceDays ?? DEFAULT_RETENTION.traceDays,
    calls_days: retention.callsDays ?? DEFAULT_RETENTION.callsDays,
  };
  return (
    // aot: false is REQUIRED on Cloudflare Workers and is not a tuning knob.
    // Elysia's default ahead-of-time compiler builds handlers with `new
    // Function()`, and workerd refuses code generation from strings:
    //   EvalError: Code generation from strings disallowed for this context
    // The failure appears on the FIRST request of a deploy, not at build time
    // and not in `bun test` — which is exactly the shape of bug that reaches
    // production. Measured here 2026-09-03 against `wrangler dev`.
    new Elysia({ aot: false })
      // The page and a desktop client both call this cross-origin. Reads are
      // safe to share; writes still require the token.
      .onAfterHandle(({ set }) => {
        set.headers["access-control-allow-origin"] = "*";
        // The three MCP headers a 2026-07-28 browser-origin client sends on
        // every POST (PRD §8.1b (3)); without them here the preflight fails
        // before the server ever sees the request (1b-2 open item → 1b-3).
        set.headers["access-control-allow-headers"] = CORS_ALLOW_HEADERS;
        set.headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
      })
      .options("/*", () => new Response(null, { status: 204 }))

      /**
       * An empty body is an empty object, not a parse error.
       *
       * A DELETE sent with `content-type: application/json` and no body — which
       * curl does the moment you reuse a header array, and which several HTTP
       * clients do by default — otherwise fails with
       * `Unexpected end of JSON input`. That names the parser's problem rather
       * than the caller's, and points nowhere near the DELETE that caused it.
       * Measured here while testing the vocabulary escape hatch.
       */
      .onParse(async ({ request }, contentType) => {
        // Every non-/mcp POST is refused above 64 KiB BEFORE the read (PRD
        // §3.3): registration metadata, a node, a passphrase or a form has no
        // business being larger, and Bun's 4 MiB cap in server.ts is the only
        // other line of defence. Labelled hardening, not brief.
        if (new URL(request.url).pathname !== "/mcp") {
          const declared = Number(request.headers.get("content-length") ?? 0);
          if (declared > MAX_JSON_BODY) throw new PayloadTooLarge(declared);
        }
        if (!contentType?.startsWith("application/json")) return;
        const text = await request.text();
        return text.trim() ? JSON.parse(text) : {};
      })

      /**
       * The gate, the OAuth endpoints and the browser login, in one `.use()`.
       *
       * Mounted BEFORE the corpus routes below, because its `onBeforeHandle` is
       * globally scoped and must be registered before the routes it guards.
       * Everything auth-shaped lives in auth-plugin.ts; nothing below this line
       * needs to know authentication exists.
       */
      .use(authPlugin({ store, auth, publicUrl, instanceName, rateLimit, clock }))

      /**
       * Errors answer as JSON, always.
       *
       * A thrown refusal is not an internal fault here — it is the product
       * telling you why: "\"aritcle\" is not an allowed content type.
       * Available: article, note." The browser form renders `message` verbatim,
       * so returning Elysia's default plain-text body would turn the single
       * most useful string in the system into "HTTP 500".
       */
      .onError(({ code, error, set }) => {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof PayloadTooLarge) {
          set.status = 413;
          return { error: "payload_too_large", message };
        }
        if (code === "VALIDATION") {
          set.status = 400;
          return { error: "validation", message };
        }
        if (code === "NOT_FOUND") {
          set.status = 404;
          return { error: "not_found", message };
        }
        set.status = 400;
        return { error: "request_failed", message };
      })

      // ── MCP ────────────────────────────────────────────────────────────────
      .post("/mcp", async ({ body, headers, request }) => {
        // Elysia has already parsed the body; handleMcp takes the object, not
        // the Request, because reading the stream twice yields nothing.
        const caller = callerFor(request);
        const response = await handleMcp(
          body,
          store,
          instanceName,
          headers["user-agent"] ?? "",
          embedder,
          caller,
          clock,
          { budget: throttled, callsRetentionDays: retentionDays.calls_days },
          // The 2026-07-28 stack reads MCP-Protocol-Version / Mcp-Method / Mcp-Name.
          request.headers,
        );
        // tool_calls / last_tool, which digger never wrote (PRD §3.9 #1). The
        // gate already counted the request, so this adds the tool alone.
        const rpc = (body ?? {}) as { method?: string; params?: { name?: unknown } };
        const gate = authOf(request);
        if (gate && rpc.method === "tools/call") {
          const tool = String(rpc.params?.name ?? "");
          if (tool) {
            await connections.record(store, gate, request, remoteAddress(request, trusted), { tool, requests: 0 }, clock);
          }
        }
        return response;
      })
      /**
       * Streamable HTTP defines GET as "open an SSE stream" and DELETE as "end
       * this session". This server is stateless and has neither, so both answer
       * 405 — the status that means "this URL is right, that verb is not".
       *
       * A 404 would be actively misleading: a client probing transports reads
       * it as a wrong URL and gives up on the endpoint entirely, rather than
       * falling back to plain POST, which works.
       */
      .get("/mcp", ({ set }) => {
        set.status = 405;
        return { error: "method_not_allowed", hint: "POST JSON-RPC to /mcp" };
      })
      .delete("/mcp", ({ set }) => {
        set.status = 405;
        return { error: "method_not_allowed", hint: "stateless: there is no session to end" };
      })

      // ── health ─────────────────────────────────────────────────────────────
      /**
       * Public /health says only that the server is up (PRD §3.3). digger
       * published counts, auth modes and the driver on an unauthenticated
       * origin — fingerprinting and capacity data for anyone who could reach
       * the port. Everything else moved behind the gate to /api/health.
       */
      .get("/health", async () => {
        let ok = true;
        try {
          await store.first("SELECT 1 AS one");
        } catch {
          ok = false;
        }
        return { ok, server: "trace-node", version };
      })

      .get("/api/health", async () => {
        let ok = true;
        let nodes = 0;
        let traces = 0;
        let digs = 0;
        let migrations = 0;
        let sqlite = "";
        try {
          nodes = await db.countNodes(store);
          traces = await countTraces(store);
          digs = await countDigs(store);
          migrations = Number(
            (await store.first<{ n: number }>("SELECT COUNT(*) AS n FROM schema_migrations"))?.n ?? 0,
          );
          sqlite = String((await store.first<{ v: string }>("SELECT sqlite_version() AS v"))?.v ?? "");
        } catch {
          ok = false;
        }
        const housekeeping = await readHousekeeping(store);
        return {
          ok,
          server: "trace-node",
          version,
          instance: instanceName,
          // Read back by gate 2 (PRD §6.4): the bun that is actually running
          // and the SQLite it bundles, not the ones the build was verified on.
          runtime: { bun: typeof Bun !== "undefined" ? Bun.version : "", sqlite },
          driver: store.driver,
          // Stated every time, so an operator never has to guess or assume —
          // and specific about WHICH doors are open, because "auth: true" on a
          // server where only the static token is configured would read as
          // "claude.ai can connect", which it could not.
          auth: guarded ? authModes(auth) : "none",
          // Stated, not inferred: whether the passphrase endpoints have a
          // guessing budget. No extra query — it is a resolved config value.
          rate_limit: guarded ? throttled : null,
          tools: TOOLS.length,
          nodes,
          traces,
          digs,
          migrations,
          // Named, not implied: a caller can see whether semantic search is
          // even possible before it returns an empty list.
          embedder: embedder ? embedder.space : null,
          // The janitor's last report (PRD §3.8), null until it has run once;
          // and what it is told to keep. `warned` is the tamper signal.
          housekeeping: housekeeping
            ? {
                last_at: housekeeping.last_at,
                next_at: housekeeping.next_at,
                evicted: housekeeping.evicted,
                data_free_mb: housekeeping.data_free_mb,
                warned: housekeeping.warned,
                errors: housekeeping.errors,
              }
            : null,
          retention: retentionDays,
          // Logged, never echoed (PRD §3.4): what clients actually send.
          protocol_versions_seen: await db.protocolVersionsSeen(store),
        };
      })

      // ── the trace layer's reads (PRD §3.3, §3.5, §3.10) ───────────────────
      // Reads OF the log: never traced, an observation must not observe
      // itself. The page polls /api/cloud, so it writes nothing by construction.
      .get("/api/cloud", async ({ query }) => await tagCloud(store, query, clock))

      /**
       * One subject's trace. Exactly one of q= / term= / node=. The visibility
       * rule decides what comes back: owner-session and api-token see every
       * row; ingress sees aggregates plus its own rows; an OAuth token needs
       * `traces:read` or is refused outright — no rows, not fewer rows.
       */
      .get("/api/trace", async ({ query, request, set }) => {
        const caller = callerFor(request);
        if (traceVisibility(caller) === "none") {
          set.status = 403;
          return { error: "forbidden", message: "The trace needs the traces:read scope; the owner grants it on the consent page." };
        }
        const report = await traceOf(
          store,
          { keyword: query.q, term_id: query.term, node_id: query.node, window: query.window, since: query.since, limit: query.limit },
          caller,
          clock,
        );
        if ("error" in report) {
          set.status = 400;
          return { error: "bad_request", message: report.error };
        }
        return report;
      })

      /**
       * Forget one keyword (PRD §3.3, §3.10; 1b-4). The owner's call only —
       * owner-session or api-token, never an OAuth token or an ingress user
       * (`isOwnerCaller`): it removes other people's rows, and the log that
       * says "this keyword was forgotten" must name the operator who did it.
       * A cookie caller additionally needs `X-Trace-Client: ui` (the gate's
       * CSRF rule). Exactly one audit row is written, under the tool name
       * `trace_forget`, with the gate's `method:principal` — and only when
       * something was forgotten: a 404 forgot nothing and logs nothing.
       */
      .delete("/api/trace", async ({ query, request, set }) => {
        const started = Date.now();
        const caller = callerFor(request);
        if (!isOwnerCaller(caller)) {
          set.status = 403;
          return { error: "forbidden", message: "Forgetting a keyword is owner-session and api-token only." };
        }
        const q = query.q === undefined ? "" : String(query.q);
        const forgotten = await forgetKeyword(store, q);
        if (!forgotten) {
          set.status = 400;
          return { error: "bad_request", message: "q= names the keyword to forget." };
        }
        if (forgotten.total === 0) {
          set.status = 404;
          return { error: "not_found", message: `nothing is remembered under "${forgotten.keyword_norm}"` };
        }
        await db.logCall(
          store,
          {
            tool: FORGET_TOOL,
            input: { q },
            outcome: "ok",
            result: { forgot: forgotten.keyword_norm, rows: forgotten.rows },
            duration_ms: Date.now() - started,
            client: caller.client,
            method: caller.method,
            principal: caller.principal,
          },
          clock,
        );
        return { ok: true, forgot: forgotten.keyword_norm, rows: forgotten.rows, total: forgotten.total };
      })

      /**
       * The categories menu (PRD §3.3, §3.7; 1b-4): every controlled
       * vocabulary with its root terms, `usage` and rolled-up `reads`.
       * Aggregates, visible to every authenticated caller; never traced —
       * a menu is navigation, the browse of one entry is the intent.
       */
      .get("/api/categories", async () => {
        const vocabularies = await listCategories(store);
        return { count: vocabularies.length, vocabularies };
      })

      /** A category browse — the one read here that carries an intent, traced. */
      .get("/api/categories/:id", async ({ params, query, request, set }) => {
        const started = Date.now();
        const term = await findCategoryTerm(store, { id: params.id });
        if (!term) {
          set.status = 404;
          return { error: "not_found", message: `no term with id ${params.id}` };
        }
        const report = await categoryOf(store, term, query, clock);
        const caller = callerFor(request);
        await traceCategory(store, caller, surfaceOf(caller, request), term, report.usage, Date.now() - started, clock);
        return report;
      })

      // ── the dig (PRD §3.6) ─────────────────────────────────────────────────
      /**
       * POST, not GET. A `SameSite=Lax` cookie rides a top-level GET
       * navigation, so any external link to a GET /api/dig would mint digs as
       * the owner; a POST cannot be a link, and the gate's CSRF rule (§3.10 c)
       * additionally requires `X-Trace-Client: ui` from a cookie or ingress
       * caller. GET answers 405 — the URL is right, the verb is not.
       */
      .post("/api/dig", async ({ body, request, set }) => {
        const caller = callerFor(request);
        const opts = (body ?? {}) as Record<string, unknown>;
        try {
          return await dig(
            store,
            opts,
            { caller, surface: surfaceOf(caller, request), embedder, clock, callsRetentionDays: retentionDays.calls_days },
            throttled,
          );
        } catch (error) {
          if (error instanceof DigBudgetExceeded) {
            set.status = 429;
            set.headers["retry-after"] = String(error.retryAfter);
            return { error: "too_many_digs", retry_after: error.retryAfter, message: error.message };
          }
          throw error;
        }
      })
      .get("/api/dig", ({ set }) => {
        set.status = 405;
        return { error: "method_not_allowed", hint: "POST JSON {q} to /api/dig" };
      })

      /** Prior digs, newest first, each with its `top`; who dug follows §3.10. Never traced. */
      .get("/api/digs", async ({ query, request }) => {
        const digs = await listDigs(store, { q: query.q, limit: query.limit }, callerFor(request));
        return { count: digs.length, digs };
      })

      // ── read API ───────────────────────────────────────────────────────────
      // The reads that carry an intent are traced here (PRD §3.1); the rest of
      // this block writes nothing, by construction — the page polls them.
      .get("/api/nodes", async ({ query, request }) => {
        const started = Date.now();
        const caller = callerFor(request);
        if (query.q) {
          const { results, mode } = await db.searchNodes(store, String(query.q), {
            limit: query.limit ? Number(query.limit) : undefined,
          });
          await traceSearch(store, caller, surfaceOf(caller, request), String(query.q), results.length, mode, Date.now() - started, clock);
          return { mode, count: results.length, nodes: results };
        }
        // Comma-separated so a URL stays readable: ?terms=topics:mcp,tags:bangkok&match=all
        const split = (value?: string) =>
          value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        const filter: db.ListFilter = {
          type: query.type,
          vocabulary: query.vocabulary,
          term_id: query.term_id,
          terms: split(query.terms),
          term_ids: split(query.term_ids),
          match: query.match === "all" ? "all" : "any",
          untagged: query.untagged === "1" || query.untagged === "true",
          status: query.status !== undefined ? Number(query.status) : undefined,
          limit: query.limit ? Number(query.limit) : undefined,
          offset: query.offset ? Number(query.offset) : undefined,
        };
        const nodes = await db.listNodes(store, filter);
        // One row per explicitly named term; `vocabulary=` alone is navigation
        // and writes nothing (PRD §3.1).
        if (filter.term_id || filter.term_ids?.length || filter.terms?.length) {
          await traceTermList(store, caller, surfaceOf(caller, request), filter, nodes.length, Date.now() - started, clock);
        }
        return { count: nodes.length, nodes };
      })

      .get("/api/nodes/:id", async ({ params, set, request }) => {
        const started = Date.now();
        const node = await db.getNode(store, params.id);
        const caller = callerFor(request);
        await traceRead(store, caller, surfaceOf(caller, request), params.id, Boolean(node), Date.now() - started, clock);
        if (!node) {
          set.status = 404;
          return { error: "not_found" };
        }
        return { ...node, terms: await db.termsForNode(store, params.id) };
      })

      /**
       * The raw log page (PRD §3.3): owner-session and api-token only — it
       * carries every principal's reads, and the visibility rule (§3.10) gives
       * an ingress user only their own rows and an OAuth token none of them.
       * Never traced: an observation must not observe itself.
       */
      .get("/api/traces", async ({ query, request, set }) => {
        const caller = callerFor(request);
        if (!isOwnerCaller(caller)) {
          set.status = 403;
          return { error: "forbidden", message: "The raw trace log is owner-session and api-token only." };
        }
        const traces = await listTraces(store, {
          kind: query.kind ? String(query.kind) : undefined,
          since: query.since ? String(query.since) : undefined,
          limit: query.limit ? Number(query.limit) : undefined,
        });
        return { count: traces.length, traces };
      })

      .get("/api/vocabularies", async () => ({ vocabularies: await db.listVocabularies(store) }))

      /** What deleting this vocabulary would cost, before deciding to. */
      .get("/api/vocabularies/:name/impact", async ({ params, set }) => {
        const impact = await db.vocabularyImpact(store, params.name);
        if (!impact) {
          set.status = 404;
          return { error: "not_found", message: `no vocabulary named "${params.name}"` };
        }
        return impact;
      })

      /**
       * The escape hatch every "controlled vocabulary" error has been promising.
       *
       * `assertTypeAllowed` tells callers to "delete the controlled type
       * vocabulary to allow free text" — advice that named an operation this
       * codebase did not have, so the only real way out was raw SQL. Deleting is
       * refused unless `?force=1` when terms would go with it, because the
       * cascade is silent and "delete the vocabulary" reads far cheaper than
       * "delete every tag anyone applied from it".
       */
      .delete("/api/vocabularies/:name", async ({ params, query, set }) => {
        try {
          const gone = await db.deleteVocabulary(store, params.name, query.force === "1" || query.force === "true");
          return { deleted: params.name, ...gone };
        } catch (error) {
          set.status = error instanceof Error && error.message.startsWith("no vocabulary") ? 404 : 409;
          return { error: "refused", message: error instanceof Error ? error.message : "failed" };
        }
      })

      .get("/api/terms", async ({ query }) => ({
        terms: await db.listTerms(store, query.vocabulary),
      }))

      .get("/api/calls", async ({ query, request }) => {
        const calls = await db.listCalls(store, {
          tool: query.tool,
          outcome: query.outcome,
          limit: query.limit ? Number(query.limit) : undefined,
        });
        // Same visibility rule as the `call_log` tool (PRD §3.10).
        return {
          calls: seesPrincipals(callerFor(request)) ? calls : calls.map((c) => ({ ...c, method: "", principal: "" })),
        };
      })

      .get("/api/calls/stats", async () => ({ tools: await db.callStats(store) }))

      /**
       * Who is connected. The Access panel's top half.
       *
       * `since` narrows the window; `claude_ai` is computed over ALL time
       * regardless, because "has claude.ai ever connected" and "did it call in
       * the last day" are different questions and the panel asks the first.
       */
      .get("/api/connections", async ({ query }) => {
        const since = connections.parseSince(query.since ? String(query.since) : null);
        return {
          since,
          connections: await connections.list(store, since),
          claude_ai: await connections.claudeAiState(store),
        };
      })

      // Taxonomy writes, so the UI can manage vocabularies and terms without
      // dropping to MCP. Same functions the tools call — one implementation.
      .post(
        "/api/vocabularies",
        async ({ body, set }) => {
          set.status = 201;
          return await db.createVocabulary(store, body);
        },
        {
          body: t.Object({
            name: t.String({ minLength: 1, maxLength: 64 }),
            label: t.Optional(t.String()),
            description: t.Optional(t.String()),
            kind: t.Optional(t.Union([t.Literal("tags"), t.Literal("categories")])),
          }),
        },
      )

      .post(
        "/api/terms",
        async ({ body, set }) => {
          set.status = 201;
          return await db.createTerm(store, {
            ...body,
            vocabularyKind: body.vocabulary_kind,
          });
        },
        {
          body: t.Object({
            vocabulary: t.String({ minLength: 1 }),
            name: t.String({ minLength: 1, maxLength: 128 }),
            description: t.Optional(t.String()),
            parent_id: t.Optional(t.String()),
            weight: t.Optional(t.Integer()),
            vocabulary_kind: t.Optional(t.Union([t.Literal("tags"), t.Literal("categories")])),
          }),
        },
      )

      /** Tag an existing node, by "vocabulary:term" names — the UI's tag picker. */
      .post(
        "/api/nodes/:id/tags",
        async ({ params, body, set }) => {
          const node = await db.getNode(store, params.id);
          if (!node) {
            set.status = 404;
            return { error: "not_found" };
          }
          const resolved = await resolveTermRefs(store, body.terms);
          const added = await db.tagNode(store, node.id, resolved.map((term) => term.id));
          return { id: node.id, added, terms: await db.termsForNode(store, node.id) };
        },
        { body: t.Object({ terms: t.Array(t.String()) }) },
      )

      .get("/api/types", async () => ({
        policy: await db.typePolicy(store),
        types: await db.listTypes(store),
      }))

      .get("/api/tools", () => ({ tools: TOOLS }))

      /** The corpus as one chronology — nodes and tool calls interleaved by
       *  event time, merged in SQL so the rowid tiebreaker is available. */
      .get("/api/timeline", async ({ query }) => ({
        events: await db.timeline(store, query.limit ? Number(query.limit) : undefined),
      }))

      .get("/api/stats", async () => ({
        ...(await db.stats(store)),
        embedding: await db.embeddingCoverage(store, embedder),
      }))

      // ── write API ──────────────────────────────────────────────────────────
      // Takes the same `terms: ["vocabulary:term"]` shape the MCP tool does, so
      // the web form and a model produce identical rows. Two write paths that
      // disagree about tagging is the "capability only exists where its users
      // are" bug this fleet keeps re-finding.
      .post(
        "/api/nodes",
        async ({ body, set }) => {
          const { terms, ...fields } = body;
          const node = await db.createNode(store, fields, embedder);
          if (terms?.length) {
            const resolved = await resolveTermRefs(store, terms);
            await db.tagNode(store, node.id, resolved.map((term) => term.id));
          }
          set.status = 201;
          return { ...node, terms: await db.termsForNode(store, node.id) };
        },
        {
          body: t.Object({
            title: t.String({ minLength: 1, maxLength: 200 }),
            body: t.Optional(t.String()),
            type: t.Optional(t.String()),
            author: t.Optional(t.String()),
            status: t.Optional(t.Integer({ minimum: 0, maximum: 1 })),
            created_at: t.Optional(t.String()),
            terms: t.Optional(t.Array(t.String())),
          }),
        },
      )

      .delete("/api/nodes/:id", async ({ params, set }) => {
        const gone = await db.deleteNode(store, params.id);
        if (!gone) {
          set.status = 404;
          return { error: "not_found" };
        }
        return { deleted: params.id };
      })

      // ── the page ───────────────────────────────────────────────────────────
      /**
       * The page decides for itself rather than being 401'd by the gate.
       *
       * A browser handed a bare 401 renders a blank tab: no form, no
       * explanation, nothing to click. So `/` is on the gate's allow-list and
       * answers with the lock screen instead — same check, a result a human can
       * act on. The 200 is deliberate; this is a page, not an API refusal, and
       * nothing about the corpus is in it.
       */
      .get("/", async ({ request }) => {
        // Home Assistant ingress serves this app under a path prefix; every
        // URL the page emits has to carry it. "" for a direct deploy.
        const base = ingressBase(request);
        const key = (auth.ownerPassphrase ?? "") + "\u0000" + ((await readStored(store)) ?? "");
        if (guarded) {
          const result = await authenticate(store, request, auth, undefined, key);
          // Through ingress, a signed-in HA user the options do not admit
          // sees the deny page here — the sidebar's first request is this
          // one, and the passphrase form is not offered through ingress at
          // all (PRD §3.9 #7, §8.1b).
          if (result.ingressDenied) return ingressDeniedResponse(request, result.ingressDenied, instanceName);
          if (!result.ok && auth.ingressAutoLogin && base) {
            // …and neither is it offered to a request that came through the
            // iframe but named nobody (Supervisor sends no X-Remote-User-Id
            // when no one is signed in to HA), nor to one that only claimed
            // to be ingress. Form-less, 401, nothing minted (1b-3 fix ruling).
            const ingress = fromIngress(request, auth.ingressPeer, parseCidrs(auth.trustedProxies));
            return ingressRefusedResponse(request, ingress.ok ? INGRESS_REFUSALS.NO_USER_ID : INGRESS_REFUSALS.NOT_INGRESS, instanceName);
          }
          if (!result.ok) {
            return new Response(loginPage({ instanceName, base }), {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }
        }
        return new Response(page(instanceName, base), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      })
  );
}

export type App = ReturnType<typeof createApp>;
