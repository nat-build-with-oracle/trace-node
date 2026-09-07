/**
 * The trace layer's write path (PRD §3.1, §3.2).
 *
 * One rule: a trace is written when a READ CARRIES AN INTENT — a keyword, a
 * term, a category, or a node id. Reads of the trace layer itself are never
 * traced: an observation must not observe itself. "Untraced" is a property of
 * the endpoint, never of a header — the page's poll endpoints write nothing by
 * construction, and everything that carries an intent is traced whatever the
 * caller sends. There is no suppression header, on purpose: with several HA
 * users admitted, any of them could otherwise read unlogged from devtools.
 *
 * One function, `recordTrace`, called from HTTP and MCP alike; two statements
 * in one batch (the raw row and its day bucket); best-effort like `logCall` —
 * a failure is one log line and the read still returns. The `connections`
 * UPSERT that §3.2 names as the batch's third statement stays where step 1 put
 * it (the /mcp handler, after the tool ran): it needs the Request and an async
 * label lookup, and the gate has already counted the request.
 */

import type { Caller } from "./auth";
import type { Store } from "./store/types";
import { termIdsByName, type ListFilter } from "./db";
import { termsByIdsSql, TRACE_WHERE, TRACES, listTracesSql } from "./sql";
import { clampLimit, newId, nowIso, type Clock } from "./utils";

export type TraceKind = "search" | "read" | "term" | "category" | "dig";
export type TraceSurface = "mcp" | "http" | "ui";
export type TraceSubject = "keyword" | "term" | "node";

/** The schema's own caps, applied at write so the CHECKs never reject a read. */
export const MAX_KEYWORD = 200;
export const MAX_CLIENT = 120;

export interface TraceEvent {
  kind: TraceKind;
  surface: TraceSurface;
  /** `keyword` for search/dig, `term` for term/category, `node` for read. */
  subject: TraceSubject;
  /** The raw spelling, for `subject: "keyword"`. Normalised here. */
  keyword?: string;
  node_id?: string;
  term_id?: string;
  vocabulary?: string;
  hits: number;
  mode?: string;
  took_ms?: number;
  dig_seq?: number;
}

export interface TraceRow {
  id: string;
  at: string;
  kind: TraceKind;
  surface: TraceSurface;
  method: string;
  principal: string;
  ha_user: string;
  subject: TraceSubject;
  subject_key: string;
  keyword: string;
  keyword_norm: string;
  node_id: string | null;
  term_id: string | null;
  vocabulary: string;
  hits: number;
  mode: string;
  took_ms: number;
  client: string;
  dig_seq: number | null;
}

/**
 * The key a keyword is remembered under (PRD §3.1).
 *
 * NFC, trimmed, inner whitespace collapsed, lower-cased, one trailing `*`
 * stripped — so "MCP", " mcp " and "mcp*" are the same intent. Thai is left
 * intact: it has no case, and the trigram index handles it as typed. Empty
 * after all that means "no intent" and the caller writes no row.
 */
export function keywordNorm(keyword: string): string {
  return String(keyword ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\*$/, "")
    .trim();
}

/**
 * Which door a read came through. A browser session or an ingress identity is
 * the page (`ui`); a Bearer is a script or a connector (`http`); the MCP wire
 * says so itself.
 */
export function surfaceOf(caller: Caller, request?: Request): TraceSurface {
  if (caller.method === "owner-session" || caller.method === "ingress") return "ui";
  if (request?.headers.get("x-trace-client") === "ui") return "ui";
  return "http";
}

/**
 * Write one trace: the raw row and its day bucket, in one batch.
 *
 * Never throws. Like `logCall`, an audit trail that can take down the read it
 * audits is worse than none — the failure is one log line and the caller's
 * answer is unaffected.
 */
export async function recordTrace(store: Store, ev: TraceEvent, caller: Caller, clock?: Clock): Promise<void> {
  try {
    const at = nowIso(clock);
    let keyword = "";
    let keywordNormValue = "";
    let subjectKey: string;
    let label = "";

    if (ev.subject === "keyword") {
      // Clip the raw spelling first, then normalise the clipped text, so the
      // stored keyword and its key always agree with each other.
      keyword = String(ev.keyword ?? "").normalize("NFC").slice(0, MAX_KEYWORD);
      keywordNormValue = keywordNorm(keyword);
      if (!keywordNormValue) return; // no intent, no row (PRD §3.1)
      subjectKey = keywordNormValue;
      label = keyword.trim();
    } else if (ev.subject === "term") {
      if (!ev.term_id) return;
      subjectKey = ev.term_id;
    } else {
      if (!ev.node_id) return;
      subjectKey = ev.node_id;
    }

    const hits = Math.max(0, Math.trunc(Number(ev.hits) || 0));
    const took = Math.max(0, Math.round(Number(ev.took_ms) || 0));

    await store.batch([
      {
        sql: TRACES.insert,
        args: [
          newId("trace"),
          at,
          ev.kind,
          ev.surface,
          caller.method,
          caller.principal,
          caller.ha_user,
          ev.subject,
          subjectKey,
          keyword,
          keywordNormValue,
          ev.node_id ?? null,
          ev.term_id ?? null,
          ev.vocabulary ?? "",
          hits,
          ev.mode ?? "",
          took,
          String(caller.client ?? "").slice(0, MAX_CLIENT),
          ev.dig_seq ?? null,
        ],
      },
      { sql: TRACES.upsertDay, args: [ev.subject, subjectKey, at, hits, took, at, label] },
    ]);
  } catch (error) {
    // Deliberately swallowed after one line: see the note above.
    console.log(`[trace] not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── the write points, shared by HTTP and MCP ─────────────────────────────────
//
// Written once here rather than at each door, for the reason `createNode`
// takes its embedder: this fleet has shipped "works on REST, missing on MCP"
// four times, and the fix is one implementation both doors call.

/** A keyword search (`node_search`, `GET /api/nodes?q=`) — kind `search`. */
export async function traceSearch(
  store: Store,
  caller: Caller,
  surface: TraceSurface,
  query: string,
  hits: number,
  mode: string,
  tookMs: number,
  clock?: Clock,
): Promise<void> {
  await recordTrace(store, { kind: "search", surface, subject: "keyword", keyword: query, hits, mode, took_ms: tookMs }, caller, clock);
}

/** A node read (`node_get`, `GET /api/nodes/:id`) — kind `read`, hits 1 or 0. */
export async function traceRead(
  store: Store,
  caller: Caller,
  surface: TraceSurface,
  nodeId: string,
  found: boolean,
  tookMs: number,
  clock?: Clock,
): Promise<void> {
  if (!nodeId) return;
  await recordTrace(store, { kind: "read", surface, subject: "node", node_id: nodeId, hits: found ? 1 : 0, took_ms: tookMs }, caller, clock);
}

interface NamedTerm {
  id: string;
  name: string;
  vocabulary: string;
  vocabulary_kind: "tags" | "categories";
}

/**
 * The terms a list filter named EXPLICITLY — `term_id`, `term_ids`, `terms` —
 * deduplicated, resolved to rows. A `vocabulary=` filter names no term and is
 * ordinary navigation (the page lists by vocabulary), so it is not here.
 * Unknown ids and names resolve to nothing: there is no term to key a row on.
 */
export async function namedTerms(store: Store, filter: ListFilter): Promise<NamedTerm[]> {
  const ids = new Set<string>(filter.term_ids ?? []);
  if (filter.term_id) ids.add(filter.term_id);
  if (filter.terms?.length) for (const id of await termIdsByName(store, filter.terms)) ids.add(id);
  const wanted = [...ids].filter(Boolean);
  if (!wanted.length) return [];
  return await store.all<NamedTerm>(termsByIdsSql(wanted.length), wanted);
}

/**
 * A list filtered by named terms (`node_list`, `/api/nodes?terms=`) — one row
 * per term, kind `term` for a free-tagging vocabulary, `category` for a
 * controlled one (PRD §3.1). Mode is `list`; hits is the result count.
 */
export async function traceTermList(
  store: Store,
  caller: Caller,
  surface: TraceSurface,
  filter: ListFilter,
  hits: number,
  tookMs: number,
  clock?: Clock,
): Promise<void> {
  const terms = await namedTerms(store, filter).catch(() => [] as NamedTerm[]);
  for (const term of terms) {
    await recordTrace(
      store,
      {
        kind: term.vocabulary_kind === "categories" ? "category" : "term",
        surface,
        subject: "term",
        term_id: term.id,
        vocabulary: term.vocabulary,
        hits,
        mode: "list",
        took_ms: tookMs,
      },
      caller,
      clock,
    );
  }
}

// ── the read side of the raw log ─────────────────────────────────────────────

/** `GET /api/traces`: the raw page, `ORDER BY at DESC, rowid DESC`. */
export async function listTraces(
  store: Store,
  opts: { kind?: string; since?: string; limit?: number } = {},
): Promise<TraceRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.kind) {
    where.push(TRACE_WHERE.kind);
    args.push(opts.kind);
  }
  if (opts.since) {
    where.push(TRACE_WHERE.since);
    args.push(opts.since);
  }
  args.push(clampLimit(opts.limit, 100, 500));
  return await store.all<TraceRow>(listTracesSql(where), args);
}

/** All traces, or those at or after `since`. */
export async function countTraces(store: Store, since?: string): Promise<number> {
  const row = since
    ? await store.first<{ c: number }>(TRACES.countSince, [since])
    : await store.first<{ c: number }>(TRACES.count);
  return Number(row?.c ?? 0);
}

export async function countDigs(store: Store): Promise<number> {
  const row = await store.first<{ c: number }>(TRACES.countDigs);
  return Number(row?.c ?? 0);
}

// ── forget one keyword (PRD §3.3, §3.10; 1b-4) ───────────────────────────────

/** The audit-log tool name a forget is filed under (pre-ruling 1). */
export const FORGET_TOOL = "trace_forget";

export interface Forgotten {
  /** The key the rows were removed under. */
  keyword_norm: string;
  rows: { traces: number; trace_days: number; digs: number };
  total: number;
}

/**
 * The one "forget this keyword" path. `trace_days.label` and `digs.keyword`
 * are otherwise retained indefinitely (0008_traces.sql), so this is the
 * data-handling statement's forget clause (PRD §3.10) made real: the raw
 * rows, the day buckets and the digs of one normalised keyword go in one
 * batch — all or nothing, since a bucket surviving its rows would re-grow the
 * label from nothing.
 *
 * Returns `null` when the keyword is empty after normalisation (no key to
 * forget under — a 400 at the door), a zero `total` when nothing matched (a
 * 404 at the door: there was nothing to forget, and nothing is logged for an
 * event that did not happen). Who may call it is the door's decision
 * (`isOwnerCaller`), not this function's.
 */
export async function forgetKeyword(store: Store, keyword: string): Promise<Forgotten | null> {
  const key = keywordNorm(String(keyword ?? "").normalize("NFC").slice(0, MAX_KEYWORD));
  if (!key) return null;
  const [traces, days, digs] = await store.batch([
    { sql: TRACES.forgetTraces, args: [key] },
    { sql: TRACES.forgetDays, args: [key] },
    { sql: TRACES.forgetDigs, args: [key] },
  ]);
  const rows = { traces: traces?.changes ?? 0, trace_days: days?.changes ?? 0, digs: digs?.changes ?? 0 };
  return { keyword_norm: key, rows, total: rows.traces + rows.trace_days + rows.digs };
}

/**
 * A category browse (`category`, `GET /api/categories/:id`) — kind `category`
 * for a controlled vocabulary, `term` for a free-tagging one (the same rule
 * the term list applies); hits = the nodes filed under it (PRD §3.1).
 */
export async function traceCategory(
  store: Store,
  caller: Caller,
  surface: TraceSurface,
  term: { id: string; vocabulary: string; vocabulary_kind: "tags" | "categories" },
  nodeCount: number,
  tookMs: number,
  clock?: Clock,
): Promise<void> {
  await recordTrace(
    store,
    {
      kind: term.vocabulary_kind === "categories" ? "category" : "term",
      surface,
      subject: "term",
      term_id: term.id,
      vocabulary: term.vocabulary,
      hits: nodeCount,
      took_ms: tookMs,
    },
    caller,
    clock,
  );
}
