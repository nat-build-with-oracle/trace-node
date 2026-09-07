/**
 * The MCP surface, hand-rolled against the JSON-RPC wire.
 *
 * Not the SDK, and that is a decision with a reason. This server is ONE
 * stateless POST endpoint. The SDK's transport layer exists to manage sessions
 * we do not want, and pinning it means inheriting its version churn on a Worker
 * that would otherwise have zero runtime dependencies.
 *
 * ── protocolVersion, the trap this fleet fell into three times ───────────────
 *
 * A client sends the revision it speaks. Three servers in this fleet answered
 * with THEIR revision, and clients that spoke a newer one connected, listed
 * zero tools, and reported no error on either side — a silent, symptomless
 * failure that took four wrong fixes to find once. So: we echo back the
 * client's requested version when we recognise its era, and fall back to the
 * newest revision we actually IMPLEMENT otherwise. Never hard-code one and
 * reject the rest — and never answer a revision we do not speak: 2026-07-28 is
 * a different wire format (no `initialize`; `server/discover`, `_meta`
 * versioning, `Mcp-Method`/`Mcp-Name` headers), and answering it while
 * speaking the old format is the same "connected, zero tools, no error" trap
 * from the other side (PRD §5.1 v0.3.1, research/claude-ai-connector-2026.md).
 *
 * Since 1b-mcp2026 (PRD §8.1b) this file speaks BOTH formats, as two stacks
 * that never share a handshake: `initialize` is the legacy stack and answers
 * only legacy revisions (a legacy client asking for 2026-07-28 hears
 * 2025-11-25, because it sent `initialize`); a request carrying
 * `_meta["io.modelcontextprotocol/protocolVersion"]` is the modern stack,
 * which knows only 2026-07-28 and tells an unlisted client so with `-32022`
 * and the supported list. The compatibility matrix in
 * research/mcp-2026-07-28-wire.md §4 is why: Modern↔Legacy fails both ways,
 * and only a dual-era server works with every client.
 */

import type { Store } from "./store/types";
import * as db from "./db";
import type { Embedder } from "./embed";
import type { Caller } from "./auth";
import { TRACES_READ } from "./oauth";
import { categoryOf, findCategoryTerm, tagCloud, traceOf, traceVisibility } from "./cloud";
import { dig } from "./dig";
import { readHousekeeping } from "./janitor";
import { countDigs, countTraces, traceCategory, traceRead, traceSearch, traceTermList } from "./trace";
import { parseTermRef, type Clock } from "./utils";
import { VERSION } from "./version";

const SERVER_NAME = "trace-node";

/** The caller an open server reports: nobody proved anything, everything is allowed. */
export const OPEN_CALLER: Caller = { method: "open", principal: "", ha_user: "", client: "", scope: "*" };

/** What the app resolved for the `dig` tool: whether the budget applies
 *  (`rateLimit`, like every other bucket) and how far the calls scan reaches. */
export interface DigToolOptions {
  budget?: boolean;
  callsRetentionDays?: number;
}

/** Revisions the legacy (`initialize`) stack speaks, newest first. A legacy
 *  client asking for anything else — older, newer (2026-07-28 included), or
 *  nonsense — still gets an answer, in the newest of THESE, rather than
 *  silence: a client that sends `initialize` is speaking this era whatever
 *  version string it names, and 2026-07-28 has no `initialize` to answer. A
 *  2026-07-28 client MUST accept an older server's answer as complete, so
 *  negotiating down is first-class. */
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// ── the 2026-07-28 stack (PRD §8.1b 1b-mcp2026; research/mcp-2026-07-28-wire.md) ──
//
// A second wire format, not a newer version of the first: no `initialize`,
// every request carries its own `_meta` protocol fields, three HTTP headers
// mirror the body so a proxy can route without parsing JSON, and every result
// says `resultType`. The spec's compatibility matrix says Modern↔Legacy fails
// in BOTH directions, so this server is dual-era: a request is routed to one
// stack by `isModern` below and the two never share a code path for the
// handshake (§8.1b (6)). The legacy stack above is gate 1a's, byte-for-byte.

/** Revisions the modern (`_meta`-versioned) stack speaks. `server/discover`
 *  lists these as `supportedVersions`, and `-32022` names them as `supported`
 *  — that error is how an unlisted modern client learns the answer. */
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"];

/** Everything this server implements, newest first — the two eras together
 *  (PRD §8.1b (7)). 2026-07-28 leads because `server/discover`, `_meta`
 *  versioning, the `Mcp-*` headers and `resultType` all exist above; it was
 *  kept out of every list until they did (§5.1 v0.3.1). Neither stack answers
 *  from this list directly: `initialize` answers from LEGACY, `-32022` from
 *  MODERN, so a legacy client never hears a version whose format it cannot speak. */
export const IMPLEMENTED_PROTOCOL_VERSIONS = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS];

/** Prefix of every reserved `_meta` key (research §2). */
export const META = "io.modelcontextprotocol/";

/**
 * JSON-RPC error codes this server emits or names, after the 2026-07-28
 * renumbering (PRD §8.1b (4); research §5). `-32020…-32099` is the new
 * MCP-reserved range; `-32000…-32019` is frozen. Two are named but never
 * emitted here, so that nobody re-allocates their numbers: no tool needs a
 * client capability (`-32021`), and this server serves no resources, so the
 * resource-not-found move from `-32002` to `-32602` has nothing to emit.
 */
export const MCP_ERRORS = {
  ParseError: -32700,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  HeaderMismatch: -32020,
  MissingRequiredClientCapability: -32021,
  UnsupportedProtocolVersion: -32022,
  ResourceNotFound: -32602,
} as const;

/** Methods whose `Mcp-Name` header must mirror `params.name` / `params.uri` (research §3). */
const NAMED_METHODS: Record<string, "name" | "uri"> = {
  "tools/call": "name",
  "resources/read": "uri",
  "prompts/get": "name",
};

/** How long a modern client may cache `server/discover` and `tools/list`. Both
 *  are constants of the binary, identical for every caller — hence `public`. */
const CACHE_TTL_MS = 3_600_000;

const INSTRUCTIONS =
  "Reads that carry a keyword, term, category or node id are logged as traces; `dig` aggregates everything this node knows about X and returns a `dig_seq`. `tag_cloud` and `trace` read the log and are never logged.";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

const text = (value: unknown) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

// ── tool catalogue ───────────────────────────────────────────────────────────
//
// Drupal in four nouns: node, vocabulary, term, and the join between them.
// Plus the log, because a tool surface you cannot inspect is one you cannot
// debug.

const TOOLS = [
  {
    name: "node_create",
    description:
      "Create a node: a title, a body, a datetime, a type. The unit of content — a post, a note, a bug, a page.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Required. 1-200 chars." },
        body: { type: "string", description: "Markdown or plain text. Optional." },
        type: { type: "string", description: "Content type, free text. Defaults to 'note'." },
        author: { type: "string" },
        status: { type: "integer", description: "1 published (default), 0 draft." },
        created_at: { type: "string", description: "ISO-8601. Defaults to now. Set it to import real history." },
        terms: {
          type: "array",
          items: { type: "string" },
          description: "Term names to tag with, as 'vocabulary:term' (e.g. 'tags:thailand'). Created if absent.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "node_get",
    description: "Read one node by id, with its taxonomy terms.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "node_update",
    description: "Change a node's title, body, type, status or author. Only the fields you pass move.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        type: { type: "string" },
        status: { type: "integer" },
        author: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "node_delete",
    description: "Delete a node permanently, with its tag links. Prefer status=0 (unpublish) — that is reversible.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "node_list",
    description:
      "List nodes newest first. Filter by type, status, vocabulary, or TAGS — pass `terms` as 'vocabulary:term' names (or `term_ids`), and set match='all' to require every tag (AND) or match='any' for at least one (OR, the default).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        status: { type: "integer" },
        terms: {
          type: "array",
          items: { type: "string" },
          description: "Tag names, e.g. ['topics:mcp','tags:bangkok']. A bare name means the 'tags' vocabulary.",
        },
        term_ids: { type: "array", items: { type: "string" }, description: "Same, by id." },
        match: {
          type: "string",
          enum: ["any", "all"],
          description: "'any' (default) = at least one tag. 'all' = every tag must be present.",
        },
        term_id: { type: "string", description: "Single tag, shorthand." },
        untagged: {
          type: "boolean",
          description: "Only nodes with no tags at all — the queue of content still waiting to be classified.",
        },
        vocabulary: { type: "string", description: "Machine name — nodes tagged from that vocabulary." },
        limit: { type: "integer", description: "1-100, default 20." },
        offset: { type: "integer" },
      },
    },
  },
  {
    name: "node_types",
    description:
      "The content types in use, with counts. Types are DERIVED — a type exists because a node names it, there is no registry to maintain. To lock the set down, create a CONTROLLED vocabulary named 'type' and add terms to it; node_create then refuses anything not on that list.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vocabulary_delete",
    description:
      "Delete a vocabulary, and with it every term in it and every tag assignment those terms carried. This is the escape hatch the controlled-vocabulary errors point at: deleting the \"type\" vocabulary returns content types to free text. Refuses unless force=true when terms would be lost, and reports exactly what would go — the cascade is silent in SQLite and 'delete the vocabulary' reads much cheaper than what it actually does.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        force: { type: "boolean", description: "Required once the vocabulary has terms." },
      },
      required: ["name"],
    },
  },
  {
    name: "node_search",
    description:
      "Search title and body. mode='text' (DEFAULT) is a trigram index — it matches inside Thai words and is the right choice for finding something you half-remember. mode='semantic' embeds the query and ranks by meaning — use it when your words are a DESCRIPTION of the thing rather than a quote from it. mode='hybrid' merges both and is opt-in for a reason: measured on this fleet's own corpus it scored WORSE than pure text for known-item retrieval (0.44 vs 0.77 MRR), because equal-weight fusion lets a confident-but-wrong neighbour list drag down a confident-and-right lexical one. Every response reports the mode that actually ran and, for semantic, how much of the corpus is embedded.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        mode: { type: "string", enum: ["text", "semantic", "hybrid"], description: "Default 'text'." },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "node_embed",
    description:
      "Embed nodes that have no vector yet, so semantic search can see them. Embedding is a second phase on purpose — writing content never waits for a model. Returns how many were embedded and the current coverage.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", description: "How many to embed this call. 1-200, default 25." } },
    },
  },
  {
    name: "node_tag",
    description:
      "Tag a node with terms, as 'vocabulary:term' (a bare name goes to 'tags'). In a free-tagging vocabulary missing terms are created; in a CONTROLLED one an unknown term is refused and the error lists what is available.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        terms: { type: "array", items: { type: "string" } },
      },
      required: ["id", "terms"],
    },
  },
  {
    name: "node_untag",
    description: "Remove terms from a node by term id. The terms themselves survive.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, term_ids: { type: "array", items: { type: "string" } } },
      required: ["id", "term_ids"],
    },
  },
  {
    name: "vocabulary_create",
    description:
      "Create a vocabulary — a namespace for terms. kind='tags' (default) is FREE-TAGGING: unknown terms are created on demand, good for many specific labels. kind='categories' is CONTROLLED: tagging with an unknown term fails, so use it for the few broad buckets you want to stay stable and un-drifted. Idempotent by name; an existing vocabulary is never re-kinded.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        label: { type: "string" },
        description: { type: "string" },
        kind: { type: "string", enum: ["tags", "categories"], description: "Default 'tags'." },
      },
      required: ["name"],
    },
  },
  {
    name: "vocabulary_list",
    description: "Every vocabulary.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "term_create",
    description:
      "Create a term in a vocabulary — the deliberate way to add to a CONTROLLED vocabulary. Hierarchical via parent_id. weight sets the order within its vocabulary (lower first), which is how a controlled vocabulary doubles as a menu. Idempotent by (vocabulary, name).",
    inputSchema: {
      type: "object",
      properties: {
        vocabulary: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        parent_id: { type: "string", description: "Nest under another term." },
        weight: { type: "integer", description: "Sort order within the vocabulary. Lower first. Default 0." },
        vocabulary_kind: {
          type: "string",
          enum: ["tags", "categories"],
          description: "Only used if this call also creates the vocabulary.",
        },
      },
      required: ["vocabulary", "name"],
    },
  },
  {
    name: "term_weight",
    description: "Set a term's sort order within its vocabulary. Lower sorts first — this is what turns a controlled vocabulary into an ordered menu.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, weight: { type: "integer" } },
      required: ["id", "weight"],
    },
  },
  {
    name: "term_list",
    description: "Terms, optionally within one vocabulary.",
    inputSchema: { type: "object", properties: { vocabulary: { type: "string" } } },
  },
  {
    name: "call_log",
    description:
      "Recent MCP tool calls with their arguments, outcome, result and duration — this server's own audit trail.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Filter to one tool name." },
        outcome: { type: "string", description: "'ok' or 'error'." },
        limit: { type: "integer", description: "1-200, default 20." },
      },
    },
  },
  {
    name: "call_stats",
    description: "Per-tool call counts, error counts, average duration and last-called time.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "status",
    description: "Corpus counts, content types, vocabularies, and this server's version.",
    inputSchema: { type: "object", properties: {} },
  },
  // ── the trace layer (PRD §3.4) ─────────────────────────────────────────────
  {
    name: "tag_cloud",
    description:
      "The cloud: every term, category and searched keyword weighted by usage (nodes wearing it) plus reads (traced searches, browses and node reads, decayed by window). window='24h'|'7d'|'all' (default 7d; day buckets, so 24h = today + yesterday×0.5). by='term'|'category'|'keyword'|'all' (default all, one shared max_n). Never traced.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "string", enum: ["24h", "7d", "all"], description: "Default '7d'." },
        by: { type: "string", enum: ["term", "category", "keyword", "all"], description: "Default 'all'." },
        limit: { type: "integer", description: "1-500, default 100." },
        include_empty: { type: "boolean", description: "Keep items with n = 0 (11 px). Default false." },
      },
    },
  },
  {
    name: "trace",
    description:
      "The read side of a log this server writes implicitly: who sought a keyword, term or node, and when. Fleet /trace and oracle_trace are find-and-log verbs; this only reads. Name EXACTLY ONE of keyword, term_id, node_id. Returns totals, a per-day sparkline that survives eviction, by_kind/by_method, and — for callers the visibility rule allows — principals and raw rows. An OAuth token needs the traces:read scope, granted only on the consent page. Never traced.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "A searched keyword, normalised as the log normalises it." },
        term_id: { type: "string" },
        node_id: { type: "string" },
        window: { type: "string", enum: ["24h", "7d", "all"], description: "Default 'all'." },
        limit: { type: "integer", description: "Raw rows, 1-500, default 100." },
      },
    },
  },
  {
    name: "category",
    description:
      "Browse one term of a controlled vocabulary: its breadcrumb path, children with usage and reads, the nodes filed under it, and reads over 24h/7d/all rolled up from every descendant. Pass id, or vocabulary + name. Traced as kind='category'.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        vocabulary: { type: "string" },
        name: { type: "string" },
        limit: { type: "integer", description: "Nodes per page, 1-100, default 20." },
        offset: { type: "integer" },
      },
    },
  },
  {
    name: "dig",
    description:
      "Everything this node knows about a keyword, in one bundle with provenance: exact and substring terms (100/25), categories with their path, text hits (title 25, body 15), nodes reached only through their tags (20), vectors when an embedder exists (else null — never an empty list pretending to have looked), prior digs of the same keyword (12, with dig_seq), the keyword's trace memory (8), tool calls that mentioned it (5) and co-occurring terms. Items under 15 come back under `weak`, not hidden: a low score is a signal, not a failure. friction = how easy it was to find (1.0 a term names it … 0.3 asked before, never filed … 0.0 nothing). WRITES: one digs row (the returned dig_seq) and one trace of kind 'dig'. Budget: 60 digs per 10 min per caller.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Required. Normalised as the log normalises it." },
        limit_per_source: { type: "integer", description: "1-50, default 10." },
        window: { type: "string", enum: ["24h", "7d", "all"], description: "Bounds traces and calls. Default 'all' (calls then bounded by retention)." },
        include: {
          type: "array",
          items: { type: "string", enum: ["terms", "categories", "nodes", "nodes_fts", "nodes_graph", "vectors", "nodes_vector", "prior_digs", "traces", "calls", "related"] },
          description: "Sources to consult. Default all nine.",
        },
      },
      required: ["keyword"],
    },
  },
];

/**
 * Fail with the caller's mistake, not the database's.
 *
 * Tagging a node that does not exist otherwise trips the node_terms foreign key
 * and the model is handed `D1_ERROR: FOREIGN KEY constraint failed:
 * SQLITE_CONSTRAINT`, which describes the storage engine's difficulty rather
 * than the thing the caller got wrong, and which no model can act on. Every
 * other tool in this file answers a bad id with `no node with id …`.
 */
async function requireNode(store: Store, id: string): Promise<db.NodeRow> {
  const node = await db.getNode(store, id);
  if (!node) throw new Error(`no node with id ${id}`);
  return node;
}

/** 'vocabulary:term' → term row, creating both if needed. A bare 'term' with no
 *  colon lands in the default 'tags' vocabulary, which is what a human means. */
export async function resolveTermRefs(store: Store, names: string[]): Promise<db.TermRow[]> {
  const out: db.TermRow[] = [];
  for (const raw of names) {
    const ref = parseTermRef(raw);
    if (!ref) continue;
    // Free-tagging creates; a controlled vocabulary refuses and lists what it
    // does have. That refusal is the whole point of the kind column.
    out.push(await db.resolveTermForTagging(store, ref.vocabulary, ref.name));
  }
  return out;
}

/**
 * May this caller see who made a call (PRD §3.10)? Owner-session and api-token
 * see everything; an OAuth token only with `traces:read`; ingress never sees
 * another principal's identity through the audit log.
 *
 * Keyed on `method`, never on `scope`: buildCaller stamps scope "*" on every
 * non-OAuth method, ingress included, so a scope check would let an HA user
 * read every other principal's identity. `open` (ALLOW_OPEN=1, local dev
 * only, §6.3) counts as the owner — the same ruling `GET /api/traces` makes.
 */
export function seesPrincipals(caller: Caller): boolean {
  if (caller.method === "open" || caller.method === "owner-session" || caller.method === "api-token") return true;
  return caller.method === "oauth" && caller.scope.split(/\s+/).includes(TRACES_READ);
}

async function runTool(
  store: Store,
  name: string,
  args: Record<string, any>,
  instanceName: string,
  embedder: Embedder | null,
  // Who asked, as the gate learned it (PRD §3.1). Every trace row reads it.
  caller: Caller,
  clock?: Clock,
  digOptions: DigToolOptions = {},
): Promise<unknown> {
  const started = Date.now();
  const took = () => Date.now() - started;
  switch (name) {
    case "node_create": {
      const node = await db.createNode(store, args as any, embedder);
      if (Array.isArray(args.terms) && args.terms.length) {
        const terms = await resolveTermRefs(store, args.terms);
        await db.tagNode(store, node.id, terms.map((t) => t.id));
      }
      return { ...node, terms: await db.termsForNode(store, node.id) };
    }
    case "node_get": {
      const node = await db.getNode(store, String(args.id));
      // A read of a node id is an intent whether or not the node exists —
      // hits says which (PRD §3.1: "1 or 0").
      await traceRead(store, caller, "mcp", String(args.id ?? ""), Boolean(node), took(), clock);
      if (!node) throw new Error(`no node with id ${args.id}`);
      return { ...node, terms: await db.termsForNode(store, node.id) };
    }
    case "node_update": {
      const node = await db.updateNode(store, String(args.id), args);
      if (!node) throw new Error(`no node with id ${args.id}`);
      return { ...node, terms: await db.termsForNode(store, node.id) };
    }
    case "node_delete": {
      const gone = await db.deleteNode(store, String(args.id));
      if (!gone) throw new Error(`no node with id ${args.id}`);
      return { deleted: args.id };
    }
    case "node_list": {
      const nodes = await db.listNodes(store, args);
      const tagged = args.terms?.length || args.term_ids?.length || args.term_id;
      // One row per EXPLICITLY named term; `vocabulary`/`untagged`/`type`
      // alone are navigation and write nothing (PRD §3.1).
      if (tagged) await traceTermList(store, caller, "mcp", args, nodes.length, took(), clock);
      return {
        // The match semantics are echoed back: "all" silently behaving as "any"
        // is the kind of filter bug you only notice as a wrong answer.
        ...(tagged ? { match: args.match === "all" ? "all" : "any" } : {}),
        count: nodes.length,
        nodes,
      };
    }
    case "node_types": {
      const types = await db.listTypes(store);
      const policy = await db.typePolicy(store);
      return { policy, count: types.length, types };
    }
    case "node_search": {
      const query = String(args.query ?? "");
      const want = String(args.mode ?? "text");

      // Semantic and hybrid both need an embedder. Saying so beats returning an
      // empty list that reads like "no matches".
      if ((want === "semantic" || want === "hybrid") && !embedder) {
        throw new Error(
          "semantic search needs an embedder; none is configured (bind Workers AI as `AI`). mode='text' still works.",
        );
      }

      if (want === "semantic" && embedder) {
        const { hits, coverage } = await db.semanticSearch(store, embedder, query, args.limit);
        await traceSearch(store, caller, "mcp", query, hits.length, "semantic", took(), clock);
        return {
          query,
          mode: "semantic",
          space: embedder.space,
          // Coverage travels with the answer: a low score because a row was
          // never embedded is NOT a ranking result, and this fleet has already
          // misread that once.
          coverage: `${coverage.embedded}/${coverage.nodes} nodes embedded`,
          count: hits.length,
          nodes: hits,
        };
      }

      if (want === "hybrid" && embedder) {
        const text = await db.searchNodes(store, query, args);
        const semantic = await db.semanticSearch(store, embedder, query, args.limit);
        // Reciprocal rank fusion, k=60. Reported as its own mode, never as
        // "search" — the caller opted into a known trade.
        const K = 60;
        const scores = new Map<string, { node: db.NodeRow; rrf: number; inText: boolean; inVector: boolean }>();
        text.results.forEach((node, index) => {
          scores.set(node.id, { node, rrf: 1 / (K + index + 1), inText: true, inVector: false });
        });
        semantic.hits.forEach((hit, index) => {
          const existing = scores.get(hit.id);
          if (existing) {
            existing.rrf += 1 / (K + index + 1);
            existing.inVector = true;
          } else {
            scores.set(hit.id, { node: hit, rrf: 1 / (K + index + 1), inText: false, inVector: true });
          }
        });
        const merged = [...scores.values()].sort((a, b) => b.rrf - a.rrf).slice(0, args.limit ?? 20);
        await traceSearch(store, caller, "mcp", query, merged.length, "hybrid", took(), clock);
        return {
          query,
          mode: "hybrid",
          note: "RRF k=60. Measured worse than mode='text' for known-item recall on this fleet's corpus.",
          coverage: `${semantic.coverage.embedded}/${semantic.coverage.nodes} nodes embedded`,
          count: merged.length,
          // Per-hit provenance: which index actually found this row.
          nodes: merged.map((m) => ({ ...m.node, found_by: [m.inText && "text", m.inVector && "vector"].filter(Boolean) })),
        };
      }

      const { results, mode } = await db.searchNodes(store, query, args);
      // The one write point for a keyword (PRD §3.1): `mode` travels with it.
      await traceSearch(store, caller, "mcp", query, results.length, mode, took(), clock);
      // The mode is part of the answer, not a footnote: 'like' means recall is
      // a substring scan, not an index hit.
      return { query, mode, count: results.length, nodes: results };
    }
    case "node_embed": {
      if (!embedder) throw new Error("no embedder configured (bind Workers AI as `AI`)");
      const result = await db.embedMissing(store, embedder, Number(args.limit) || 25);
      const coverage = await db.embeddingCoverage(store, embedder);
      return { ...result, coverage };
    }
    case "node_tag": {
      // Check the node exists BEFORE resolving terms. Without this the insert
      // fails on the foreign key and the model is told
      // "D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT" — which
      // names the database's problem instead of the caller's, and is not
      // something a model can act on. Every other tool here says which id was
      // wrong; this one leaked the driver. Found by reading the call log.
      await requireNode(store, String(args.id));
      const terms = await resolveTermRefs(store, args.terms ?? []);
      const added = await db.tagNode(store, String(args.id), terms.map((t) => t.id));
      return { id: args.id, added, terms: await db.termsForNode(store, String(args.id)) };
    }
    case "node_untag": {
      await requireNode(store, String(args.id));
      const removed = await db.untagNode(store, String(args.id), args.term_ids ?? []);
      return { id: args.id, removed, terms: await db.termsForNode(store, String(args.id)) };
    }
    case "vocabulary_create":
      return await db.createVocabulary(store, args as any);
    case "vocabulary_delete": {
      const gone = await db.deleteVocabulary(store, String(args.name), Boolean(args.force));
      return { deleted: args.name, ...gone };
    }
    case "vocabulary_list":
      return { vocabularies: await db.listVocabularies(store) };
    case "term_create":
      return await db.createTerm(store, {
        ...(args as any),
        vocabularyKind: args.vocabulary_kind,
      });
    case "term_weight": {
      const term = await db.setTermWeight(store, String(args.id), Number(args.weight));
      if (!term) throw new Error(`no term with id ${args.id}`);
      return term;
    }
    case "term_list":
      return { terms: await db.listTerms(store, args.vocabulary) };
    case "call_log": {
      // Rows carry method/principal since 0009; the visibility rule (PRD
      // §3.10) blanks them for a caller who may not see who else called.
      const calls = await db.listCalls(store, args);
      return {
        calls: seesPrincipals(caller) ? calls : calls.map((c) => ({ ...c, method: "", principal: "" })),
      };
    }
    case "call_stats":
      return { tools: await db.callStats(store) };
    case "status": {
      const dayAgo = new Date((clock ? clock() : new Date()).getTime() - 24 * 60 * 60 * 1000).toISOString();
      const top = await tagCloud(store, { window: "7d", by: "keyword", limit: 1 }, clock);
      return {
        server: SERVER_NAME,
        version: VERSION,
        instance: instanceName,
        tools: TOOLS.length,
        ...(await db.stats(store)),
        // Coverage in status, because an agent cannot otherwise ask how much of
        // the corpus semantic search can actually see.
        embedding: await db.embeddingCoverage(store, embedder),
        // The trace layer at a glance (PRD §3.4).
        traces_24h: await countTraces(store, dayAgo),
        digs: await countDigs(store),
        top_keyword_7d: top.items[0] ? { label: top.items[0].label, key: top.items[0].key, reads: top.items[0].reads } : null,
        housekeeping: await readHousekeeping(store),
      };
    }
    // ── the trace layer (PRD §3.4) — reads of the log, never traced ─────────
    case "tag_cloud":
      return await tagCloud(store, args, clock);
    case "trace": {
      // The first enforced scope (PRD §3.10): without it, isError and NO rows.
      if (traceVisibility(caller) === "none") {
        throw new Error(`trace needs the ${TRACES_READ} scope; the owner grants it on the consent page.`);
      }
      const report = await traceOf(store, args, caller, clock);
      if ("error" in report) throw new Error(report.error);
      return report;
    }
    case "category": {
      const term = await findCategoryTerm(store, args);
      if (!term) throw new Error(args.id ? `no term with id ${args.id}` : `no term ${args.vocabulary ?? "?"}:${args.name ?? "?"}; pass id, or vocabulary + name`);
      const report = await categoryOf(store, term, args, clock);
      await traceCategory(store, caller, "mcp", term, report.usage, took(), clock);
      return report;
    }
    // The one read that is also a write (PRD §3.6): a digs row and a trace of
    // kind 'dig'; its sub-queries are untraced. Over budget → isError.
    case "dig":
      return await dig(
        store,
        args,
        { caller, surface: "mcp", embedder, clock, callsRetentionDays: digOptions.callsRetentionDays },
        digOptions.budget ?? true,
      );
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/**
 * Takes an ALREADY-PARSED body, not a Request.
 *
 * The framework in front of this reads the body first; a second `request.json()`
 * here sees a consumed stream and every call fails as a parse error. Measured
 * 2026-09-03 — the symptom is every tool returning -32700 while /health is fine.
 */
export async function handleMcp(
  body: unknown,
  store: Store,
  instanceName = "trace-node",
  userAgent = "",
  embedder: Embedder | null = null,
  caller: Caller = OPEN_CALLER,
  clock?: Clock,
  digOptions: DigToolOptions = {},
  // The request headers, for the modern stack's `MCP-Protocol-Version` /
  // `Mcp-Method` / `Mcp-Name` checks. The legacy stack never reads them.
  headers: Headers = new Headers(),
): Promise<Response> {
  const rpc = (body ?? {}) as JsonRpcRequest;
  if (!rpc || typeof rpc !== "object" || typeof rpc.method !== "string") {
    return Response.json(err(null, -32700, "parse error"), { status: 400 });
  }

  const ctx: CallContext = { store, instanceName, userAgent, embedder, caller, clock, digOptions };
  if (isModern(rpc, headers)) return handleModern(rpc, headers, ctx);

  const id = rpc.id ?? null;
  const method = rpc.method;
  const params = rpc.params ?? {};
  const client =
    (params.clientInfo as { name?: string } | undefined)?.name || userAgent || "unknown";

  switch (method) {
    case "initialize": {
      const asked = String((params as any).protocolVersion ?? "");
      const version = LEGACY_PROTOCOL_VERSIONS.includes(asked) ? asked : LEGACY_PROTOCOL_VERSIONS[0];
      // Logged, never echoed (PRD §3.4): /api/health lists what clients send.
      await db.noteProtocolVersion(store, asked, clock);
      return Response.json(
        ok(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: VERSION },
          instructions: INSTRUCTIONS,
        }),
      );
    }
    // Notifications carry no id and expect no body.
    case "notifications/initialized":
    case "initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return Response.json(ok(id, {}));
    case "tools/list":
      return Response.json(ok(id, { tools: TOOLS }));
    case "tools/call":
      return Response.json(ok(id, await callTool(params, client, ctx)));
    default:
      return Response.json(err(id, -32601, `method not found: ${method}`));
  }
}

/** Everything a tool call needs besides the request itself. */
interface CallContext {
  store: Store;
  instanceName: string;
  userAgent: string;
  embedder: Embedder | null;
  caller: Caller;
  clock?: Clock;
  digOptions: DigToolOptions;
}

/**
 * One `tools/call`, era-neutral: runs the tool, logs the call, and hands back
 * the result object (`content`, plus `isError` on failure). Both stacks wrap
 * it; the modern one adds `resultType` and `_meta` around it.
 */
async function callTool(params: Record<string, unknown>, client: string, ctx: CallContext) {
  const { store, instanceName, embedder, caller, clock, digOptions } = ctx;
  const name = String((params as any).name ?? "");
  const args = ((params as any).arguments ?? {}) as Record<string, unknown>;
  const started = Date.now();
  const who = { method: caller.method, principal: caller.principal };
  try {
    const result = await runTool(store, name, args as Record<string, any>, instanceName, embedder, caller, clock, digOptions);
    await db.logCall(
      store,
      { tool: name, input: args, outcome: "ok", result, duration_ms: Date.now() - started, client, ...who },
      clock,
    );
    return text(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.logCall(
      store,
      { tool: name, input: args, outcome: "error", result: message, duration_ms: Date.now() - started, client, ...who },
      clock,
    );
    // isError keeps the failure inside the tool result, which is where an
    // MCP client shows it to the model — a JSON-RPC error would be a
    // transport fault instead, and the model would never see the reason.
    return { ...text(message), isError: true };
  }
}

// ── the modern stack ─────────────────────────────────────────────────────────

/**
 * Which era is this request? Modern when its `_meta` carries any reserved
 * `io.modelcontextprotocol/` key (the presence rule of PRD §8.1b (6) — a
 * `_meta` that names `clientCapabilities` but forgets `protocolVersion` is a
 * malformed modern request, and must hear `-32602`, not be processed under
 * legacy semantics), when the method exists only in the modern era, or when
 * the `MCP-Protocol-Version` header claims a modern revision with no `_meta`
 * to back it. Anything else — a bare `initialize`, a 2025-11-25 client that
 * sends the 2025-06-18 header — is legacy, untouched.
 */
function isModern(rpc: JsonRpcRequest, headers: Headers): boolean {
  const meta = rpc.params?._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta) && Object.keys(meta).some((k) => k.startsWith(META))) return true;
  if (rpc.method === "server/discover") return true;
  const claimed = headers.get("mcp-protocol-version");
  return claimed !== null && MODERN_PROTOCOL_VERSIONS.includes(claimed);
}

/** Header values that are not plain ASCII travel as `=?base64?<b64>?=`
 *  (research §3); the server decodes before comparing. */
function decodeHeaderValue(value: string): string {
  const wrapped = /^=\?base64\?([A-Za-z0-9+/=_-]*)\?=$/.exec(value.trim());
  if (!wrapped) return value;
  try {
    const raw = atob(wrapped[1].replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
  } catch {
    return value;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * The 2026-07-28 request path, in the order the PRD lists the rules:
 * `_meta` (`-32602`/400), the three headers (`-32020`/400, `-32022`/400),
 * then the method. Every JSON-RPC error here is an HTTP 400 — the spec makes
 * a dual-era client read the body of a 400 before falling back, so the code
 * and `data` are the whole negotiation. Unknown method is 404 + `-32601`.
 * Every result carries `resultType` and echoes `serverInfo` in `_meta`.
 */
async function handleModern(rpc: JsonRpcRequest, headers: Headers, ctx: CallContext): Promise<Response> {
  const { store, clock, userAgent } = ctx;
  const id = rpc.id ?? null;
  const method = rpc.method as string;
  const params = rpc.params ?? {};
  const meta: Record<string, unknown> = isObject(params._meta) ? params._meta : {};
  const fail = (code: number, message: string, data?: unknown, status = 400) =>
    Response.json(err(id, code, message, data), { status });
  const mismatch = (header: string, expected: unknown, got: string | null) =>
    fail(
      MCP_ERRORS.HeaderMismatch,
      `HeaderMismatch: ${header} ${got === null ? "is required" : "does not match the request body"}`,
      { header, expected, got },
    );

  // (2) `_meta`: protocolVersion and clientCapabilities required; clientInfo
  // SHOULD; logLevel optional. Every received version is logged (PRD §3.4).
  const asked = meta[`${META}protocolVersion`];
  if (typeof asked !== "string" || !asked) {
    return fail(MCP_ERRORS.InvalidParams, `invalid params: _meta["${META}protocolVersion"] is required`, {
      missing: [`${META}protocolVersion`],
    });
  }
  await db.noteProtocolVersion(store, asked, clock);

  // (3) MCP-Protocol-Version must mirror the body, and name a revision we speak.
  const claimed = headers.get("mcp-protocol-version");
  if (claimed === null || claimed.trim() !== asked) return mismatch("MCP-Protocol-Version", asked, claimed);
  if (!MODERN_PROTOCOL_VERSIONS.includes(asked)) {
    return fail(MCP_ERRORS.UnsupportedProtocolVersion, `UnsupportedProtocolVersion: ${asked}`, {
      requested: asked,
      supported: MODERN_PROTOCOL_VERSIONS,
    });
  }

  const caps = meta[`${META}clientCapabilities`];
  if (!isObject(caps)) {
    return fail(MCP_ERRORS.InvalidParams, `invalid params: _meta["${META}clientCapabilities"] is required`, {
      missing: [`${META}clientCapabilities`],
    });
  }
  const clientInfo = meta[`${META}clientInfo`];
  if (clientInfo !== undefined && !isObject(clientInfo)) {
    return fail(MCP_ERRORS.InvalidParams, `invalid params: _meta["${META}clientInfo"] must be an object`);
  }
  const logLevel = meta[`${META}logLevel`];
  if (logLevel !== undefined && typeof logLevel !== "string") {
    return fail(MCP_ERRORS.InvalidParams, `invalid params: _meta["${META}logLevel"] must be a string`);
  }

  // (3) Mcp-Method mirrors `method`; Mcp-Name mirrors `params.name`/`params.uri`
  // on the three named methods. Names are case-sensitive, headers are not.
  const sentMethod = headers.get("mcp-method");
  if (sentMethod === null || decodeHeaderValue(sentMethod) !== method) return mismatch("Mcp-Method", method, sentMethod);
  const nameKey = NAMED_METHODS[method];
  if (nameKey) {
    const want = params[nameKey];
    const sentName = headers.get("mcp-name");
    if (sentName === null || typeof want !== "string" || decodeHeaderValue(sentName) !== want) {
      return mismatch("Mcp-Name", typeof want === "string" ? want : null, sentName);
    }
  }

  // (5) resultType on every result; serverInfo echoed in `_meta` (research §2).
  const complete = (result: Record<string, unknown>) => ({
    resultType: "complete",
    ...result,
    _meta: { [`${META}serverInfo`]: { name: SERVER_NAME, version: VERSION } },
  });
  const client = (isObject(clientInfo) && typeof clientInfo.name === "string" && clientInfo.name) || userAgent || "unknown";

  // Notifications carry no id and expect no body — after the header checks,
  // because a malformed notification is still a malformed request.
  if (method.startsWith("notifications/") && rpc.id === undefined) return new Response(null, { status: 202 });

  switch (method) {
    // (1) server/discover: no params beyond `_meta`; DiscoverResult.
    case "server/discover": {
      const extra = Object.keys(params).filter((k) => k !== "_meta");
      if (extra.length) return fail(MCP_ERRORS.InvalidParams, `invalid params: server/discover takes no params beyond _meta`, { extra });
      return Response.json(
        ok(
          id,
          complete({
            supportedVersions: MODERN_PROTOCOL_VERSIONS,
            capabilities: { tools: {} },
            instructions: INSTRUCTIONS,
            ttlMs: CACHE_TTL_MS,
            cacheScope: "public",
          }),
        ),
      );
    }
    case "ping":
      return Response.json(ok(id, complete({})));
    // CacheableResult (research §6b): the catalogue is a constant of the
    // binary, in a deterministic order, so an hour of public caching is honest.
    case "tools/list":
      return Response.json(ok(id, complete({ tools: TOOLS, ttlMs: CACHE_TTL_MS, cacheScope: "public" })));
    case "tools/call":
      return Response.json(ok(id, complete(await callTool(params, client, ctx))));
    // `initialize` lands here only with a modern `_meta` on it — the mixed
    // request PRD §8.1b (6) forbids. It does not exist in this era.
    default:
      return fail(MCP_ERRORS.MethodNotFound, `method not found: ${method}`, undefined, 404);
  }
}

export { TOOLS };
