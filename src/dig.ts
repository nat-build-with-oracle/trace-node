/**
 * The dig (PRD §3.6): "everything the node knows about X", with provenance.
 *
 * Nine sources in one bundle — terms, categories, FTS nodes, graph-reached
 * nodes, vectors, prior digs, traces, tool calls, related terms — each item
 * carrying `{source, id, label, score, why}` so a reader can see WHY a row is
 * in the answer and not only that it is. Scores are tiers, not probabilities:
 * an exact term name is 100, a substring 25, a title hit 25, a body hit 15, a
 * node reached only through its tags 20, a prior dig 12, a trace 8, a call 5.
 * Items under the confident floor (15) are returned under `weak[]`, not hidden:
 * "a low score is a signal, not a failure".
 *
 * It is the one read that is also a write. Every dig leaves a `digs` row with
 * a `dig_seq` (AUTOINCREMENT — the fix for a registry whose sequence numbers
 * were duplicated and null) and one trace of kind `dig`; its own sub-queries
 * are never traced. The MCP annotations say so: `readOnlyHint: false`.
 *
 * Budget: 60 digs per 10 minutes per `method:principal`, counted from the
 * `digs` table itself against the app clock — the ledger is the counter, so a
 * frozen clock in a test and a real one in production read the same rows.
 */

import type { Caller } from "./auth";
import { traceVisibility, type CloudWindow, cutoffDay, parseWindow } from "./cloud";
import { searchNodes, semanticSearch, type NodeRow, type TermRow, type VocabularyKind } from "./db";
import type { Embedder } from "./embed";
import { DEFAULT_RETENTION } from "./janitor";
import { DIG, DIGS_LIST, digGraphSql, digRelatedSql, TRACE_OF } from "./sql";
import type { Store } from "./store/types";
import { keywordNorm, MAX_KEYWORD, recordTrace, type TraceSurface } from "./trace";
import { clampLimit, nowIso, type Clock } from "./utils";

/** The nine `include` keys, one per `counts` field. `nodes` and `vectors`
 *  (PRD §3.4's shorter spellings) and `related_terms` are accepted as aliases. */
export const DIG_SOURCES = [
  "terms",
  "categories",
  "nodes_fts",
  "nodes_graph",
  "nodes_vector",
  "prior_digs",
  "traces",
  "calls",
  "related",
] as const;
export type DigSource = (typeof DIG_SOURCES)[number];

const ALIASES: Record<string, DigSource[]> = {
  nodes: ["nodes_fts", "nodes_graph"],
  vectors: ["nodes_vector"],
  related_terms: ["related"],
};

/** Tier scores (PRD §3.6). */
export const SCORE = {
  termExact: 100,
  termLike: 25,
  nodeTitle: 25,
  nodeBody: 15,
  nodeGraph: 20,
  vectorMax: 20,
  priorDig: 12,
  trace: 8,
  call: 5,
  relatedPerNode: 5,
  relatedCap: 25,
} as const;

/** Items at or above this are `items[]`; below, `weak[]`. */
export const CONFIDENT_FLOOR = 15;

/** The budget (PRD §3.3): digs per window per `method:principal`. */
export const DIG_BUDGET = { digs: 60, windowSeconds: 10 * 60 } as const;

/** Reached-`related` is `LIMIT 10` in the PRD's own query; calls scan the last 20. */
const RELATED_LIMIT = 10;
const CALLS_SCAN = 20;
const TOP_ITEMS = 5;

export interface DigOptions {
  keyword?: unknown;
  q?: unknown;
  limit_per_source?: unknown;
  window?: unknown;
  include?: unknown;
}

export interface DigItem {
  source: string;
  id: string;
  label: string;
  score: number;
  why: string;
  at?: string;
  dig_seq?: number;
}

export interface DigCounts {
  terms: number;
  categories: number;
  nodes_fts: number;
  nodes_graph: number;
  nodes_vector: number | null;
  traces: number;
  calls: number;
  related: number;
  prior_digs: number;
}

export interface DigBundle {
  keyword: string;
  keyword_norm: string;
  dig_seq: number;
  friction: number;
  confidence: "high" | "medium" | "low";
  as_of: string;
  dug_by: string;
  window: CloudWindow;
  limit_per_source: number;
  include: DigSource[];
  counts: DigCounts;
  terms: Array<TermRow & { vocabulary: string; vocabulary_kind: VocabularyKind; score: number }>;
  categories: Array<TermRow & { vocabulary: string; vocabulary_kind: VocabularyKind; score: number; path: Array<{ id: string; name: string }> }>;
  nodes_fts: Array<NodeRow & { score: number }>;
  nodes_graph: Array<NodeRow & { score: number; via: string[] }>;
  nodes_vector: Array<NodeRow & { score: number; cosine: number }> | null;
  traces: {
    count: number;
    first: string | null;
    last: string | null;
    by_kind: Record<string, number>;
    principals: Array<{ principal: string; method: string; ha_user?: string; n: number }>;
    days: Array<{ day: string; reads: number; hits: number }>;
  };
  prior_digs: Array<{ dig_seq: number; at: string; friction: number; confidence: string; top: unknown[] }>;
  calls: Array<{ tool: string; at: string; client: string; input?: string }>;
  related_terms: Array<{ id: string; name: string; vocabulary: string; co: number; score: number }>;
  items: DigItem[];
  weak: DigItem[];
  took_ms: number;
}

export interface DigContext {
  caller: Caller;
  surface: TraceSurface;
  embedder?: Embedder | null;
  clock?: Clock;
  /** Bounds the `mcp_calls` scan when `window` is `all` (PRD §3.6). */
  callsRetentionDays?: number;
}

/** The refusal the budget gives; the doors turn it into 429 or `isError`. */
export class DigBudgetExceeded extends Error {
  constructor(public readonly retryAfter: number) {
    super(`dig budget: ${DIG_BUDGET.digs} digs per ${DIG_BUDGET.windowSeconds / 60} min per caller; try again in ${retryAfter}s`);
  }
}

/** `%`, `_` and `\` in a LIKE needle mean themselves, never wildcards. */
export const escapeLike = (needle: string): string => needle.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The sources a caller asked for: all nine by default, aliases expanded, unknown names ignored. */
export function parseInclude(value: unknown): DigSource[] {
  if (value === undefined || value === null) return [...DIG_SOURCES];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const wanted = new Set<DigSource>();
  for (const entry of raw) {
    const name = String(entry ?? "").trim();
    if (!name) continue;
    if ((DIG_SOURCES as readonly string[]).includes(name)) wanted.add(name as DigSource);
    for (const alias of ALIASES[name] ?? []) wanted.add(alias);
  }
  return DIG_SOURCES.filter((s) => wanted.has(s));
}

/**
 * Friction and confidence (PRD §3.6).
 *
 *   S = 1.0 any term hit · 0.7 only FTS/graph/vector · 0.3 only traces/calls/prior digs · 0.0 nothing
 *   C = 0 if confident items ≥ 3 · −0.10 if 1–2 · −0.20 if 0
 *   friction = clamp(S + C, 0, 1)
 *
 * `C` counts the CONFIDENT items (`items[]`), never `weak[]`: confidence is a
 * statement about what was found above the floor, and the 0.3 tier — every
 * item under it by construction — is the "asked before, never filed" signal
 * the UI renders as such.
 */
export function friction(counts: DigCounts, confidentItems: number): { friction: number; confidence: "high" | "medium" | "low" } {
  const termHit = counts.terms + counts.categories > 0;
  const contentHit = counts.nodes_fts + counts.nodes_graph + (counts.nodes_vector ?? 0) > 0;
  const memoryHit = counts.traces + counts.calls + counts.prior_digs > 0;
  const s = termHit ? 1.0 : contentHit ? 0.7 : memoryHit ? 0.3 : 0.0;
  const confidence = confidentItems >= 3 ? "high" : confidentItems >= 1 ? "medium" : "low";
  const c = confidence === "high" ? 0 : confidence === "medium" ? -0.1 : -0.2;
  return { friction: Math.min(1, Math.max(0, Number((s + c).toFixed(2)))), confidence };
}

/** Seconds until this caller may dig again, or 0 now. */
export async function digRetryAfter(store: Store, caller: Caller, clock?: Clock): Promise<number> {
  const now = clock ? clock() : new Date();
  const cutoff = new Date(now.getTime() - DIG_BUDGET.windowSeconds * 1000).toISOString();
  const count = Number((await store.first<{ c: number }>(DIG.budgetCount, [caller.method, caller.principal, cutoff]))?.c ?? 0);
  if (count < DIG_BUDGET.digs) return 0;
  const nth = await store.first<{ at: string }>(DIG.budgetOldest, [caller.method, caller.principal, cutoff, DIG_BUDGET.digs - 1]);
  const frees = nth ? new Date(nth.at).getTime() + DIG_BUDGET.windowSeconds * 1000 : now.getTime();
  return Math.max(1, Math.ceil((frees - now.getTime()) / 1000));
}

const containsFold = (haystack: string, needle: string): boolean => haystack.normalize("NFC").toLowerCase().includes(needle);

/**
 * The dig. Throws `DigBudgetExceeded` when the caller is over budget and a
 * plain Error on an empty keyword; every source failure short of that is the
 * caller's answer, not an exception.
 */
export async function dig(store: Store, opts: DigOptions, ctx: DigContext, budget = true): Promise<DigBundle> {
  const started = Date.now();
  const { caller, clock } = ctx;
  // Clip the raw spelling to the schema cap FIRST, then normalise the clipped
  // text — the same two steps, in the same order, as `recordTrace` and
  // `forgetKeyword`. A dig keyed from the unclipped text would leave a
  // `digs.keyword_norm` longer than the trace row's and than any forget key,
  // and that dig could never be forgotten (1b-4 fix).
  const clipped = String(opts.keyword ?? opts.q ?? "").normalize("NFC").slice(0, MAX_KEYWORD);
  const keyword = clipped.trim();
  const norm = keywordNorm(clipped);
  if (!norm) throw new Error("dig needs a keyword");
  if (budget) {
    const wait = await digRetryAfter(store, caller, clock);
    if (wait > 0) throw new DigBudgetExceeded(wait);
  }

  const now = clock ? clock() : new Date();
  const asOf = nowIso(clock);
  const window = parseWindow(opts.window, "all");
  const limit = clampLimit(opts.limit_per_source, 10, 50);
  const include = parseInclude(opts.include);
  const on = (source: DigSource) => include.includes(source);
  const visibility = traceVisibility(caller);
  // §3.10: the call log is not an aggregate. Owner-session/api-token see
  // `input`; a `traces:read` token and an ingress user see `{tool, at, client}`;
  // an OAuth token without the scope sees no calls at all — the same branch
  // that leaves `traces.principals` empty for it.
  const seesInput = visibility === "all";
  const seesCalls = visibility !== "none";
  const escaped = escapeLike(norm);
  const items: DigItem[] = [];

  // ── terms and categories ───────────────────────────────────────────────────
  type TermHit = TermRow & { vocabulary: string; vocabulary_kind: VocabularyKind; score: number };
  const termHits: TermHit[] = [];
  // The exact hits are also the graph's roots and the related arm's seeds, so
  // they are looked up whenever any of those is on — even with `terms` off.
  if (on("terms") || on("categories") || on("nodes_graph") || on("related")) {
    const exact = await store.all<TermHit>(DIG.termsExact, [norm]);
    for (const t of exact) termHits.push({ ...t, score: SCORE.termExact });
  }
  if (on("terms") || on("categories")) {
    const like = await store.all<TermHit>(DIG.termsLike, [escaped, norm, limit]);
    for (const t of like) termHits.push({ ...t, score: SCORE.termLike });
  }
  const terms = on("terms") ? termHits.filter((t) => t.vocabulary_kind !== "categories").slice(0, limit) : [];
  const categories: DigBundle["categories"] = [];
  if (on("categories")) {
    for (const t of termHits.filter((t) => t.vocabulary_kind === "categories").slice(0, limit)) {
      categories.push({ ...t, path: await store.all<{ id: string; name: string }>(DIG.path, [t.id]) });
    }
  }
  for (const t of terms) {
    items.push({ source: "term", id: t.id, label: `${t.vocabulary}:${t.name}`, score: t.score, why: t.score === SCORE.termExact ? "exact term name" : "term name contains the keyword", at: t.created_at });
  }
  for (const t of categories) {
    items.push({ source: "category", id: t.id, label: `${t.vocabulary}:${t.name}`, score: t.score, why: t.score === SCORE.termExact ? "exact category name" : "category name contains the keyword", at: t.created_at });
  }
  // The exact hits are the graph's roots and the related query's seeds.
  const exactIds = termHits.filter((t) => t.score === SCORE.termExact).map((t) => t.id);
  const hitIds = termHits.map((t) => t.id);

  // ── nodes: FTS, then the graph reach ───────────────────────────────────────
  let nodesFts: DigBundle["nodes_fts"] = [];
  if (on("nodes_fts")) {
    const { results } = await searchNodes(store, norm, { limit });
    nodesFts = results.map((n) => ({ ...n, score: containsFold(n.title, norm) ? SCORE.nodeTitle : SCORE.nodeBody }));
    for (const n of nodesFts) {
      items.push({ source: "node_fts", id: n.id, label: n.title, score: n.score, why: n.score === SCORE.nodeTitle ? "title matches" : "body matches", at: n.created_at });
    }
  }
  const ftsIds = new Set(nodesFts.map((n) => n.id));
  let nodesGraph: DigBundle["nodes_graph"] = [];
  if (on("nodes_graph") && exactIds.length) {
    const reached = await store.all<NodeRow>(digGraphSql(exactIds.length), [...exactIds, limit + ftsIds.size]);
    nodesGraph = reached
      .filter((n) => !ftsIds.has(n.id))
      .slice(0, limit)
      .map((n) => ({ ...n, score: SCORE.nodeGraph, via: exactIds }));
    for (const n of nodesGraph) {
      items.push({ source: "node_graph", id: n.id, label: n.title, score: n.score, why: "tagged with the exact term, not a text hit", at: n.created_at });
    }
  }

  // ── vectors: only when an embedder exists — null is "did not look" ────────
  let nodesVector: DigBundle["nodes_vector"] = null;
  if (on("nodes_vector") && ctx.embedder) {
    const { hits } = await semanticSearch(store, ctx.embedder, norm, limit);
    nodesVector = hits.map((h) => {
      const { score: cosineScore, ...node } = h;
      return { ...node, cosine: cosineScore, score: Math.round(SCORE.vectorMax * cosineScore) };
    });
    for (const n of nodesVector) {
      items.push({ source: "node_vector", id: n.id, label: n.title, score: n.score, why: `cosine ${n.cosine.toFixed(2)}`, at: n.created_at });
    }
  }

  // ── prior digs: "we have been here" ────────────────────────────────────────
  let priorDigs: DigBundle["prior_digs"] = [];
  if (on("prior_digs")) {
    const rows = await store.all<{ dig_seq: number; at: string; friction: number; confidence: string; top: string }>(DIG.prior, [norm, limit]);
    priorDigs = rows.map((r) => ({ dig_seq: Number(r.dig_seq), at: r.at, friction: Number(r.friction), confidence: r.confidence, top: parseJson(r.top, []) }));
    for (const d of priorDigs) {
      items.push({ source: "prior_dig", id: String(d.dig_seq), label: `dig #${d.dig_seq}`, score: SCORE.priorDig, why: `dug before, friction ${d.friction}`, at: d.at, dig_seq: d.dig_seq });
    }
  }

  // ── traces: the memory of this keyword, filtered by §3.10 ──────────────────
  const traces: DigBundle["traces"] = { count: 0, first: null, last: null, by_kind: {}, principals: [], days: [] };
  if (on("traces")) {
    const dayCutoff = cutoffDay(window, now);
    const rowCutoff = window === "all" ? "" : new Date(now.getTime() - (window === "24h" ? 1 : 7) * 24 * 60 * 60 * 1000).toISOString();
    const totals = await store.first<{ count: number; first: string | null; last: string | null }>(TRACE_OF.totals, ["keyword", norm, dayCutoff]);
    traces.count = Number(totals?.count ?? 0);
    traces.first = totals?.first ?? null;
    traces.last = totals?.last ?? null;
    traces.days = (await store.all<{ day: string; reads: number; hits: number }>(TRACE_OF.days, ["keyword", norm, dayCutoff])).map((d) => ({
      day: d.day,
      reads: Number(d.reads),
      hits: Number(d.hits),
    }));
    traces.by_kind = Object.fromEntries(
      (await store.all<{ kind: string; n: number }>(TRACE_OF.byKind, ["keyword", norm, rowCutoff])).map((r) => [r.kind, Number(r.n)]),
    );
    if (visibility === "all" || visibility === "scoped") {
      const grouped = await store.all<{ method: string; principal: string; ha_user: string; n: number }>(TRACE_OF.principals, ["keyword", norm, rowCutoff]);
      traces.principals = grouped.map((p) => ({ principal: p.principal, method: p.method, ...(visibility === "all" ? { ha_user: p.ha_user } : {}), n: Number(p.n) }));
    } else if (visibility === "own" && caller.ha_user) {
      const own = await store.first<{ n: number }>(DIG.ownTraces, [norm, caller.ha_user, rowCutoff]);
      if (Number(own?.n ?? 0) > 0) traces.principals = [{ principal: caller.principal, method: caller.method, ha_user: caller.ha_user, n: Number(own!.n) }];
    }
    if (traces.principals.length) {
      for (const p of traces.principals) {
        items.push({ source: "trace", id: `${p.method}:${p.principal}`, label: p.ha_user ? `${p.method}:${p.principal} (${p.ha_user})` : `${p.method}:${p.principal}`, score: SCORE.trace, why: `sought ${p.n}×`, at: traces.last ?? undefined });
      }
    } else if (traces.count > 0) {
      items.push({ source: "trace", id: norm, label: `sought ${traces.count}×`, score: SCORE.trace, why: "traced reads of this keyword", at: traces.last ?? undefined });
    }
  }

  // ── calls: the audit log, bounded by the window or by retention ───────────
  // Skipped, not scanned-then-hidden, for a caller §3.10 keeps out: no rows,
  // no `call` items, `counts.calls` 0.
  let calls: DigBundle["calls"] = [];
  if (on("calls") && seesCalls) {
    const days = window === "24h" ? 1 : window === "7d" ? 7 : (ctx.callsRetentionDays ?? DEFAULT_RETENTION.callsDays);
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = await store.all<{ id: string; tool: string; called_at: string; client: string; input: string }>(DIG.calls, [escaped, cutoff, CALLS_SCAN]);
    calls = rows.slice(0, limit).map((r) => ({ tool: r.tool, at: r.called_at, client: r.client, ...(seesInput ? { input: r.input } : {}) }));
    rows.slice(0, limit).forEach((r) => {
      items.push({ source: "call", id: r.id, label: r.tool, score: SCORE.call, why: `input mentions the keyword (${r.client || "unknown client"})`, at: r.called_at });
    });
  }

  // ── related terms: co-occurrence on the same nodes ─────────────────────────
  let related: DigBundle["related_terms"] = [];
  if (on("related") && hitIds.length) {
    const rows = await store.all<{ id: string; name: string; vocabulary: string; co: number }>(digRelatedSql(hitIds.length), [...hitIds, ...hitIds, Math.min(RELATED_LIMIT, limit)]);
    related = rows.map((r) => ({ ...r, co: Number(r.co), score: Math.min(SCORE.relatedCap, SCORE.relatedPerNode * Number(r.co)) }));
    for (const r of related) {
      items.push({ source: "related_term", id: r.id, label: `${r.vocabulary}:${r.name}`, score: r.score, why: `shares ${r.co} node${r.co === 1 ? "" : "s"} with a hit term` });
    }
  }

  // ── merge, floor, friction ─────────────────────────────────────────────────
  items.sort((a, b) => b.score - a.score || (b.at ?? "").localeCompare(a.at ?? "") || a.label.localeCompare(b.label));
  const confident = items.filter((i) => i.score >= CONFIDENT_FLOOR);
  const weak = items.filter((i) => i.score < CONFIDENT_FLOOR);
  const counts: DigCounts = {
    terms: terms.length,
    categories: categories.length,
    nodes_fts: nodesFts.length,
    nodes_graph: nodesGraph.length,
    nodes_vector: nodesVector === null ? null : nodesVector.length,
    traces: traces.count,
    calls: calls.length,
    related: related.length,
    prior_digs: priorDigs.length,
  };
  const tier = friction(counts, confident.length);
  const top = confident.slice(0, TOP_ITEMS).map((i) => ({ source: i.source, id: i.id, score: i.score }));
  const tookMs = Date.now() - started;

  // ── the ledger row, then the trace ─────────────────────────────────────────
  const inserted = await store.run(DIG.insert, [
    asOf,
    keyword,
    norm,
    caller.method,
    caller.principal,
    caller.ha_user,
    tier.friction,
    tier.confidence,
    JSON.stringify(counts),
    JSON.stringify(top),
    tookMs,
  ]);
  const digSeq = Number(inserted.lastRowId ?? 0);
  await recordTrace(store, { kind: "dig", surface: ctx.surface, subject: "keyword", keyword: clipped, hits: confident.length, dig_seq: digSeq, took_ms: tookMs }, caller, clock);

  return {
    keyword,
    keyword_norm: norm,
    dig_seq: digSeq,
    friction: tier.friction,
    confidence: tier.confidence,
    as_of: asOf,
    dug_by: caller.ha_user ? `${caller.method}:${caller.principal} (${caller.ha_user})` : `${caller.method}:${caller.principal}`,
    window,
    limit_per_source: limit,
    include,
    counts,
    terms,
    categories,
    nodes_fts: nodesFts,
    nodes_graph: nodesGraph,
    nodes_vector: nodesVector,
    traces,
    prior_digs: priorDigs,
    calls,
    related_terms: related,
    items: confident,
    weak,
    took_ms: tookMs,
  };
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export interface DigRow {
  dig_seq: number;
  at: string;
  keyword: string;
  keyword_norm: string;
  method: string;
  principal: string;
  ha_user: string;
  friction: number;
  confidence: string;
  counts: DigCounts;
  top: Array<{ source: string; id: string; score: number }>;
  took_ms: number;
}

/**
 * Prior digs, newest first (`GET /api/digs`). Every authenticated caller sees
 * that a dig happened and what it found; WHO dug it follows the visibility
 * rule (PRD §3.10): owner-session/api-token everything, an OAuth token with
 * `traces:read` the principal but not the HA user, ingress only its own
 * identity, anyone else nothing.
 */
export async function listDigs(store: Store, opts: { q?: unknown; limit?: unknown }, caller: Caller): Promise<DigRow[]> {
  const norm = opts.q === undefined || opts.q === null ? "" : keywordNorm(String(opts.q));
  const rows = await store.all<Omit<DigRow, "counts" | "top"> & { counts: string; top: string }>(DIGS_LIST, [norm, norm, clampLimit(opts.limit, 100, 500)]);
  const visibility = traceVisibility(caller);
  return rows.map((r) => {
    const own = visibility === "own" && caller.ha_user !== "" && r.ha_user === caller.ha_user;
    const showWho = visibility === "all" || visibility === "scoped" || own;
    const showHaUser = visibility === "all" || own;
    return {
      dig_seq: Number(r.dig_seq),
      at: r.at,
      keyword: r.keyword,
      keyword_norm: r.keyword_norm,
      method: showWho ? r.method : "",
      principal: showWho ? r.principal : "",
      ha_user: showHaUser ? r.ha_user : "",
      friction: Number(r.friction),
      confidence: r.confidence,
      counts: parseJson<DigCounts>(r.counts, { terms: 0, categories: 0, nodes_fts: 0, nodes_graph: 0, nodes_vector: null, traces: 0, calls: 0, related: 0, prior_digs: 0 }),
      top: parseJson(r.top, []),
      took_ms: Number(r.took_ms),
    };
  });
}
