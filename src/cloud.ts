/**
 * The read side of the trace layer (PRD §3.3, §3.5, §3.10): the cloud, one
 * subject's trace, and a category with its reads.
 *
 * None of this writes a trace. `tag_cloud` and `trace` read the log the server
 * writes implicitly — an observation must not observe itself — and the one
 * read here that DOES carry an intent, a category browse, is traced by the
 * handler that calls `categoryOf`, not in here, so the write point stays at
 * the door where the caller is known.
 *
 * Every window is computed from `trace_days` at day granularity. `24h` is
 * today's bucket plus yesterday's × 0.5, not a rolling day; the response says
 * `granularity: "day"` out loud rather than letting the name imply otherwise.
 */

import type { Caller } from "./auth";
import type { NodeRow, TermRow, VocabularyKind } from "./db";
import { TRACES_READ } from "./oauth";
import { CATEGORIES, CATEGORY, cloudSql, NODES, TRACE_OF, traceRowsSql, type CloudBy, type CloudWindow } from "./sql";
import type { Store } from "./store/types";
import { keywordNorm, type TraceRow, type TraceSubject } from "./trace";
import { clampLimit, clampOffset, type Clock } from "./utils";

export type { CloudBy, CloudWindow };

/** Half-lives in days (PRD §3.5): one for 24h, seven for 7d, none for all. */
const HALF_LIFE: Record<Exclude<CloudWindow, "all">, number> = { "24h": 1, "7d": 7 };
/** How many day buckets a window reaches back, inclusive of the cutoff day. */
const WINDOW_DAYS: Record<Exclude<CloudWindow, "all">, number> = { "24h": 1, "7d": 7 };

const DAY_MS = 24 * 60 * 60 * 1000;

export const parseWindow = (value: unknown, fallback: CloudWindow = "7d"): CloudWindow =>
  value === "24h" || value === "7d" || value === "all" ? value : fallback;

export const parseBy = (value: unknown): CloudBy =>
  value === "term" || value === "category" || value === "keyword" ? value : "all";

/** `YYYY-MM-DD` of the app clock, and of N days before it. */
const dayOf = (at: Date, minusDays = 0): string => new Date(at.getTime() - minusDays * DAY_MS).toISOString().slice(0, 10);

/** The first day a window reaches, or "" for all time. */
export function cutoffDay(window: CloudWindow, now: Date): string {
  return window === "all" ? "" : dayOf(now, WINDOW_DAYS[window]);
}

export interface CloudItem {
  label: string;
  subject: TraceSubject;
  key: string;
  id?: string;
  vocabulary?: string;
  kind: "term" | "category" | "keyword";
  usage: number;
  reads: number;
  hits: number;
  n: number;
  weight: number;
  size_px: number;
  last: string | null;
}

export interface Cloud {
  window: CloudWindow;
  by: CloudBy;
  max_n: number;
  granularity: "day";
  items: CloudItem[];
}

export interface CloudOptions {
  window?: unknown;
  by?: unknown;
  limit?: unknown;
  include_empty?: unknown;
}

const truthy = (value: unknown): boolean =>
  value === true || value === 1 || value === "1" || value === "true";

/** digger's law, in px: 11 only when `n = 0`, 20 at `max_n`. */
export const sizePx = (weight: number): number => Number((11 + 9 * weight).toFixed(1));

/**
 * The cloud (PRD §3.5). Aggregates only — visible to every authenticated
 * caller; there is no principal in it to protect.
 */
export async function tagCloud(store: Store, opts: CloudOptions = {}, clock?: Clock): Promise<Cloud> {
  const window = parseWindow(opts.window);
  const by = parseBy(opts.by);
  const now = clock ? clock() : new Date();
  const limit = clampLimit(opts.limit, 100, 500);
  const includeEmpty = truthy(opts.include_empty) ? 1 : 0;
  const halfLife = window === "all" ? 0 : HALF_LIFE[window];
  const rows = await store.all<{
    kind: CloudItem["kind"];
    subject: TraceSubject;
    key: string;
    id: string | null;
    label: string | null;
    vocabulary: string;
    usage: number;
    reads: number;
    hits: number;
    n: number;
    max_n: number;
    last: string | null;
    weight: number;
  }>(cloudSql(by, window), [dayOf(now), halfLife, cutoffDay(window, now), includeEmpty, limit]);

  const items: CloudItem[] = rows.map((r) => {
    const weight = Number(r.weight) || 0;
    const item: CloudItem = {
      label: r.label ?? "",
      subject: r.subject,
      key: r.key,
      kind: r.kind,
      usage: Number(r.usage) || 0,
      reads: Number(r.reads) || 0,
      hits: Number(r.hits) || 0,
      n: Number(r.n) || 0,
      weight,
      size_px: sizePx(weight),
      last: r.last ?? null,
    };
    if (r.id) item.id = r.id;
    if (r.vocabulary) item.vocabulary = r.vocabulary;
    return item;
  });
  return { window, by, max_n: Number(rows[0]?.max_n ?? 0), granularity: "day", items };
}

// ── visibility (PRD §3.10) ───────────────────────────────────────────────────

/**
 * What a caller may see of a trace's rows:
 *
 *   all        owner-session, api-token (and `open`, local dev only): every
 *              row, every principal, `ha_user`
 *   scoped     an OAuth token carrying `traces:read`: rows and principals,
 *              `ha_user` blanked — the scope grants the log, not the people
 *   own        ingress: aggregates plus the caller's own rows, never another
 *              `ha_user`
 *   none       an OAuth token without the scope: aggregates only elsewhere,
 *              and `trace` itself refuses with no rows
 *
 * Keyed on `method`, never on `scope` — the same reason `seesPrincipals` gives.
 */
export type TraceVisibility = "all" | "scoped" | "own" | "none";

export function traceVisibility(caller: Caller): TraceVisibility {
  if (caller.method === "open" || caller.method === "owner-session" || caller.method === "api-token") return "all";
  if (caller.method === "ingress") return "own";
  if (caller.method === "oauth" && caller.scope.split(/\s+/).includes(TRACES_READ)) return "scoped";
  return "none";
}

// ── one subject's trace ──────────────────────────────────────────────────────

export interface TraceQuery {
  /** Exactly one of these three (PRD §3.4: three explicit optionals). */
  keyword?: unknown;
  term_id?: unknown;
  node_id?: unknown;
  window?: unknown;
  since?: unknown;
  limit?: unknown;
}

export interface TracePrincipal {
  principal: string;
  method: string;
  ha_user?: string;
  n: number;
}

export interface TraceReport {
  subject: TraceSubject;
  key: string;
  label: string;
  window: CloudWindow;
  granularity: "day";
  count: number;
  first: string | null;
  last: string | null;
  by_kind: Record<string, number>;
  by_method: Record<string, number>;
  principals: TracePrincipal[];
  days: Array<{ day: string; reads: number; hits: number }>;
  rows: Array<Partial<TraceRow>>;
}

/** The subject a query names, or a reason it names none or several. */
export function traceSubjectOf(q: TraceQuery): { subject: TraceSubject; key: string } | { error: string } {
  const named: Array<[TraceSubject, string]> = [];
  const keyword = q.keyword === undefined || q.keyword === null ? "" : String(q.keyword);
  if (keyword.trim()) named.push(["keyword", keywordNorm(keyword)]);
  if (q.term_id !== undefined && q.term_id !== null && String(q.term_id).trim()) named.push(["term", String(q.term_id).trim()]);
  if (q.node_id !== undefined && q.node_id !== null && String(q.node_id).trim()) named.push(["node", String(q.node_id).trim()]);
  if (named.length !== 1) {
    return { error: "name exactly one of keyword (q), term_id (term) or node_id (node)" };
  }
  const [subject, key] = named[0]!;
  if (!key) return { error: "the keyword is empty after normalisation" };
  return { subject, key };
}

const ROW_FIELDS: Array<keyof TraceRow> = [
  "at", "kind", "surface", "method", "principal", "ha_user", "client", "hits", "mode", "took_ms", "node_id", "term_id", "dig_seq",
];

/**
 * Everything the log knows about one keyword, term or node (PRD §3.3), filtered
 * by what THIS caller may see (§3.10). The caller decides `visibility` from
 * the gate's result; `none` never reaches here — the handler refused first.
 */
export async function traceOf(
  store: Store,
  q: TraceQuery,
  caller: Caller,
  clock?: Clock,
): Promise<TraceReport | { error: string }> {
  const named = traceSubjectOf(q);
  if ("error" in named) return named;
  const { subject, key } = named;
  const visibility = traceVisibility(caller);
  if (visibility === "none") return { error: `trace needs the ${TRACES_READ} scope` };

  const window = parseWindow(q.window, "all");
  const now = clock ? clock() : new Date();
  const limit = clampLimit(q.limit, 100, 500);
  // Days and totals come from the buckets (day cutoff); rows and their facts
  // from the raw log (instant cutoff). `since` narrows both further.
  let dayCutoff = cutoffDay(window, now);
  let rowCutoff = window === "all" ? "" : new Date(now.getTime() - WINDOW_DAYS[window] * DAY_MS).toISOString();
  const since = q.since ? String(q.since) : "";
  if (since) {
    if (!dayCutoff || since.slice(0, 10) > dayCutoff) dayCutoff = since.slice(0, 10);
    if (!rowCutoff || since > rowCutoff) rowCutoff = since;
  }

  const totals = await store.first<{ count: number; first: string | null; last: string | null }>(TRACE_OF.totals, [subject, key, dayCutoff]);
  const days = await store.all<{ day: string; reads: number; hits: number }>(TRACE_OF.days, [subject, key, dayCutoff]);
  const byKind = await store.all<{ kind: string; n: number }>(TRACE_OF.byKind, [subject, key, rowCutoff]);
  const byMethod = await store.all<{ method: string; n: number }>(TRACE_OF.byMethod, [subject, key, rowCutoff]);

  let label = "";
  if (subject === "keyword") {
    label = (await store.first<{ label: string }>(TRACE_OF.latestLabel, [key]))?.label ?? "";
  } else if (subject === "term") {
    label = (await store.first<TermRow>(CATEGORY.byId, [key]))?.name ?? "";
  } else {
    label = (await store.first<NodeRow>(NODES.byId, [key]))?.title ?? "";
  }

  // Principals and rows, by visibility.
  let principals: TracePrincipal[] = [];
  let rows: Array<Partial<TraceRow>> = [];
  if (visibility === "all" || visibility === "scoped") {
    const grouped = await store.all<{ method: string; principal: string; ha_user: string; n: number }>(TRACE_OF.principals, [subject, key, rowCutoff]);
    principals = grouped.map((p) => ({
      principal: p.principal,
      method: p.method,
      ...(visibility === "all" ? { ha_user: p.ha_user } : {}),
      n: Number(p.n),
    }));
    rows = await store.all<TraceRow>(traceRowsSql(false), [subject, key, rowCutoff, "", limit]);
  } else {
    // Ingress: the caller's own rows only — and only when HA named them; an
    // anonymous ingress caller (`ha_user` "") owns no rows at all.
    if (caller.ha_user) {
      rows = await store.all<TraceRow>(traceRowsSql(true), [subject, key, rowCutoff, caller.ha_user, limit]);
      const own = rows.length;
      if (own) principals = [{ principal: caller.principal, method: caller.method, ha_user: caller.ha_user, n: own }];
    }
  }
  const projected = rows.map((r) => {
    const out: Partial<TraceRow> = {};
    for (const field of ROW_FIELDS) (out as Record<string, unknown>)[field] = (r as Record<string, unknown>)[field];
    if (visibility === "scoped") out.ha_user = "";
    return out;
  });

  return {
    subject,
    key,
    label,
    window,
    granularity: "day",
    count: Number(totals?.count ?? 0),
    first: totals?.first ?? null,
    last: totals?.last ?? null,
    by_kind: Object.fromEntries(byKind.map((r) => [r.kind, Number(r.n)])),
    by_method: Object.fromEntries(byMethod.map((r) => [r.method, Number(r.n)])),
    principals,
    days: days.map((d) => ({ day: d.day, reads: Number(d.reads), hits: Number(d.hits) })),
    rows: projected,
  };
}

// ── one category ─────────────────────────────────────────────────────────────

export interface CategoryReport {
  term: TermRow;
  vocabulary: string;
  kind: VocabularyKind;
  path: Array<{ id: string; name: string }>;
  children: Array<{ id: string; name: string; weight: number; usage: number; reads: number }>;
  nodes: NodeRow[];
  usage: number;
  reads_24h: number;
  reads_7d: number;
  reads_all: number;
  last_read: string | null;
}

/** The term a category request names: by id, or by vocabulary + name. */
export async function findCategoryTerm(
  store: Store,
  ref: { id?: unknown; vocabulary?: unknown; name?: unknown },
): Promise<(TermRow & { vocabulary: string; vocabulary_kind: VocabularyKind }) | null> {
  type Row = TermRow & { vocabulary: string; vocabulary_kind: VocabularyKind };
  if (ref.id !== undefined && ref.id !== null && String(ref.id).trim()) {
    return await store.first<Row>(CATEGORY.byId, [String(ref.id).trim()]);
  }
  if (ref.vocabulary && ref.name) {
    return await store.first<Row>(CATEGORY.byVocabularyAndName, [String(ref.vocabulary).trim(), String(ref.name).trim()]);
  }
  return null;
}

// ── every category (PRD §3.3 `GET /api/categories`, 1b-4) ───────────────────

export interface CategoryRoot {
  id: string;
  name: string;
  description: string;
  weight: number;
  usage: number;
  reads: number;
  last: string | null;
}

export interface CategoryVocabulary {
  id: string;
  name: string;
  label: string;
  description: string;
  kind: "categories";
  created_at: string;
  terms: CategoryRoot[];
}

/**
 * The controlled vocabularies with their root terms — the sidebar's
 * categories "menu" (PRD §3.7), each entry carrying `usage` and all-time
 * rolled-up `reads` so the page can size it without a second call. A
 * vocabulary with no root term yet is still listed (an empty menu is
 * information). Aggregates only: visible to every authenticated caller
 * (§3.10), and never traced — the menu is navigation, not an intent.
 */
export async function listCategories(store: Store): Promise<CategoryVocabulary[]> {
  const vocabularies = await store.all<Omit<CategoryVocabulary, "terms">>(CATEGORIES.vocabularies);
  const roots = await store.all<CategoryRoot & { vocabulary_id: string }>(CATEGORIES.roots);
  return vocabularies.map((v) => ({
    ...v,
    kind: "categories",
    terms: roots
      .filter((t) => t.vocabulary_id === v.id)
      .map(({ vocabulary_id: _vocabularyId, ...t }) => ({
        ...t,
        weight: Number(t.weight),
        usage: Number(t.usage) || 0,
        reads: Number(t.reads) || 0,
        last: t.last ?? null,
      })),
  }));
}

/**
 * A category with its breadcrumb, children, nodes and reads (PRD §3.3). Reads
 * roll up from every descendant and from searches spelt like the name, as the
 * cloud's category arm counts them. The trace of this read is written by the
 * caller with `hits = usage` — the count of nodes filed here.
 */
export async function categoryOf(
  store: Store,
  term: TermRow & { vocabulary: string; vocabulary_kind: VocabularyKind },
  opts: { limit?: unknown; offset?: unknown } = {},
  clock?: Clock,
): Promise<CategoryReport> {
  const now = clock ? clock() : new Date();
  const { vocabulary, vocabulary_kind, ...bare } = term;
  const path = await store.all<{ id: string; name: string }>(CATEGORY.path, [term.id]);
  const children = await store.all<{ id: string; name: string; weight: number; usage: number; reads: number }>(CATEGORY.children, [term.id]);
  const nodes = await store.all<NodeRow>(CATEGORY.nodes, [term.id, clampLimit(opts.limit, 20, 100), clampOffset(opts.offset)]);
  const usage = Number((await store.first<{ c: number }>(CATEGORY.usage, [term.id]))?.c ?? 0);
  const reads = await store.first<{ reads_24h: number; reads_7d: number; reads_all: number; last_read: string | null }>(CATEGORY.reads, [
    term.id,
    dayOf(now, 1),
    dayOf(now, 7),
    keywordNorm(term.name),
  ]);
  return {
    term: bare as TermRow,
    vocabulary,
    kind: vocabulary_kind,
    path,
    children: children.map((c) => ({ ...c, usage: Number(c.usage), reads: Number(c.reads) })),
    nodes,
    usage,
    reads_24h: Number(reads?.reads_24h ?? 0),
    reads_7d: Number(reads?.reads_7d ?? 0),
    reads_all: Number(reads?.reads_all ?? 0),
    last_read: reads?.last_read ?? null,
  };
}
