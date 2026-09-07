/**
 * The repository: functions over a Store, every statement imported from sql.ts.
 *
 * Two rules hold this layer honest:
 *   1. No SQL text lives here. Want a query? Add a constant to sql.ts — that
 *      file is the audit surface and it only works if it is complete.
 *   2. No D1 types live here. Everything goes through the Store port, which is
 *      what lets the identical code run on a Worker (D1), in `bun test`
 *      (in-memory SQLite), and inside a desktop app (a file on disk).
 */

import {
  CALL_WHERE,
  CALLS,
  listCallsSql,
  listNodesByTermsSql,
  listNodesSql,
  listUntaggedSql,
  termIdsByNameSql,
  TYPES,
  NODE_TERMS,
  NODE_WHERE,
  NODES,
  SETTINGS,
  STATS,
  TERMS,
  VOCABULARIES,
  type NodeJoin,
} from "./sql";
import type { Embedder } from "./embed";
import type { Store } from "./store/types";
import { clampLimit, clampOffset, clip, ftsPhrase, newId, nowIso, parseTermRef, slugify, type Clock } from "./utils";

export type { Store };

export interface NodeRow {
  id: string;
  type: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  status: number;
  author: string;
}

export interface TermRow {
  id: string;
  vocabulary_id: string;
  name: string;
  description: string;
  parent_id: string | null;
  /** The owner's chosen order within its vocabulary. Lower sorts first. */
  weight: number;
  created_at: string;
  /** Present on list queries, which join the vocabulary for convenience. */
  vocabulary?: string;
  vocabulary_kind?: VocabularyKind;
  /** Nodes wearing this term. Present on list queries — the tag cloud's size. */
  usage?: number;
}

/**
 * Drupal's two vocabulary kinds, and the reason this column exists:
 *
 *   "tags"       free-tagging — unknown terms are created on demand
 *   "categories" controlled  — tagging with an unknown term is an ERROR
 *
 * The second is the guard against a model inventing three spellings of one idea.
 */
export type VocabularyKind = "tags" | "categories";

export interface VocabularyRow {
  id: string;
  name: string;
  label: string;
  description: string;
  kind: VocabularyKind;
  created_at: string;
}

export interface CallLogRow {
  id: string;
  called_at: string;
  tool: string;
  input: string;
  outcome: string;
  result: string;
  duration_ms: number;
  client: string;
  /** Who ran it, as the gate knew them (0009). `client` above is a label. */
  method: string;
  principal: string;
}

export interface ListFilter {
  type?: string;
  status?: number;
  /** One term, kept for the simple case. */
  term_id?: string;
  /** Many terms, by id. */
  term_ids?: string[];
  /** Many terms, by "vocabulary:term" name — what a human or a model types. */
  terms?: string[];
  /** "all" = every term must be present (AND). "any" = at least one (OR). */
  match?: "any" | "all";
  /** Only nodes with no terms at all — the model's tagging queue. */
  untagged?: boolean;
  vocabulary?: string;
  limit?: number;
  offset?: number;
}

/** "vocabulary:term" names → ids, in one query. Unknown names are dropped. */
export async function termIdsByName(store: Store, names: string[]): Promise<string[]> {
  const refs = names
    .map((raw) => parseTermRef(raw))
    .filter((ref): ref is { vocabulary: string; name: string } => Boolean(ref))
    .map((ref) => `${slugify(ref.vocabulary)}:${ref.name}`);
  if (!refs.length) return [];
  const rows = await store.all<{ id: string }>(termIdsByNameSql(refs.length), refs);
  return rows.map((row) => row.id);
}

// ── nodes ────────────────────────────────────────────────────────────────────

/**
 * Create a node, and — if an embedder is supplied — embed it opportunistically.
 *
 * The embedder argument lives HERE rather than at each call site on purpose.
 * This fleet has shipped the same bug four times: a capability wired into the
 * REST path but not the MCP path, so "it works" was true of whichever door the
 * author happened to test. Writing it once in the shared layer is the fix, and
 * it is why both doors are provably equivalent in the tests.
 */
export async function createNode(
  store: Store,
  input: {
    type?: string;
    title: string;
    body?: string;
    author?: string;
    status?: number;
    created_at?: string;
  },
  embedder?: Embedder | null,
): Promise<NodeRow> {
  const type = input.type ?? "note";
  // Enforced here, in the shared layer, so both write doors get it.
  await assertTypeAllowed(store, type);

  const id = newId("node");
  const now = nowIso();
  // created_at is settable so an importer can preserve real history; it
  // defaults to now, which is what every interactive caller wants.
  await store.run(NODES.insert, [
    id,
    type,
    input.title,
    input.body ?? "",
    input.created_at ?? now,
    now,
    input.status ?? 1,
    input.author ?? "",
  ]);
  const node = (await getNode(store, id))!;
  // Best-effort: the row is already durable, so a down model costs a backfill,
  // never the content.
  if (embedder) await embedNode(store, embedder, node);
  return node;
}

export async function getNode(store: Store, id: string): Promise<NodeRow | null> {
  return await store.first<NodeRow>(NODES.byId, [id]);
}

export async function updateNode(
  store: Store,
  id: string,
  patch: { type?: string; title?: string; body?: string; status?: number; author?: string },
): Promise<NodeRow | null> {
  const existing = await getNode(store, id);
  if (!existing) return null;
  if (patch.type && patch.type !== existing.type) await assertTypeAllowed(store, patch.type);
  await store.run(NODES.update, [
    patch.type ?? existing.type,
    patch.title ?? existing.title,
    patch.body ?? existing.body,
    patch.status ?? existing.status,
    patch.author ?? existing.author,
    nowIso(),
    id,
  ]);
  return await getNode(store, id);
}

export async function deleteNode(store: Store, id: string): Promise<boolean> {
  const result = await store.run(NODES.delete, [id]);
  return result.changes > 0;
}

export async function countNodes(store: Store): Promise<number> {
  const row = await store.first<{ c: number }>(NODES.count);
  return row?.c ?? 0;
}

export async function listNodes(store: Store, filter: ListFilter = {}): Promise<NodeRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];

  if (filter.type) {
    where.push(NODE_WHERE.type);
    args.push(filter.type);
  }
  if (filter.status !== undefined && Number.isFinite(Number(filter.status))) {
    where.push(NODE_WHERE.status);
    args.push(Number(filter.status));
  }

  if (filter.untagged) {
    return await store.all<NodeRow>(listUntaggedSql(where), [
      ...args,
      clampLimit(filter.limit, 20, 100),
      clampOffset(filter.offset),
    ]);
  }

  // ── multi-term filtering ──────────────────────────────────────────────────
  // Collect ids from every shape the caller may have used, then dedupe: asking
  // for the same term twice must not change an "all" match's required count.
  const askedForTerms = Boolean(filter.term_id || filter.term_ids?.length || filter.terms?.length);
  const ids = new Set<string>(filter.term_ids ?? []);
  if (filter.term_id) ids.add(filter.term_id);
  if (filter.terms?.length) for (const id of await termIdsByName(store, filter.terms)) ids.add(id);

  // A filter that matches nothing must return nothing. Falling through to the
  // unfiltered query here would answer "show me nodes tagged X" — for an X that
  // does not exist — with the ENTIRE corpus. Caught by its own test.
  if (askedForTerms && ids.size === 0) return [];

  if (ids.size > 0) {
    const termIds = [...ids];
    const match = filter.match === "all" ? "all" : "any";
    const limit = clampLimit(filter.limit, 20, 100);
    const offset = clampOffset(filter.offset);
    const bound = [...args, ...termIds];
    // "all" binds the required count between the terms and the paging args.
    if (match === "all") bound.push(termIds.length);
    bound.push(limit, offset);
    return await store.all<NodeRow>(listNodesByTermsSql(termIds.length, match, where), bound);
  }

  // The join is chosen by the SHAPE of the filter, so the SQL fragment is
  // always one of sql.ts's own literals — never a caller string.
  let join: NodeJoin = "none";
  if (filter.vocabulary) {
    join = "byVocabulary";
    where.push(NODE_WHERE.vocabularyName);
    args.push(slugify(filter.vocabulary));
  }

  args.push(clampLimit(filter.limit, 20, 100), clampOffset(filter.offset));
  return await store.all<NodeRow>(listNodesSql(join, where), args);
}

/**
 * Search, with an honest fallback.
 *
 * 3+ characters use the trigram index. Shorter needles CANNOT — a trigram index
 * has nothing to match — so they fall back to a LIKE scan, and the caller is
 * told which path ran. A search tool that silently degrades is one that lies
 * about its own recall.
 */
export async function searchNodes(
  store: Store,
  query: string,
  filter: ListFilter = {},
): Promise<{ results: NodeRow[]; mode: "fts" | "like" }> {
  const limit = clampLimit(filter.limit, 20, 100);
  const trimmed = query.trim();

  if (trimmed.length >= 3) {
    try {
      const results = await store.all<NodeRow>(NODES.searchFts, [ftsPhrase(trimmed), limit]);
      return { results, mode: "fts" };
    } catch {
      // A backend without trigram FTS5 must not take search down entirely.
    }
  }

  const like = `%${trimmed}%`;
  const results = await store.all<NodeRow>(NODES.searchLike, [like, like, limit]);
  return { results, mode: "like" };
}

// ── taxonomy ─────────────────────────────────────────────────────────────────

export async function createVocabulary(
  store: Store,
  input: { name: string; label?: string; description?: string; kind?: VocabularyKind },
): Promise<VocabularyRow> {
  const name = slugify(input.name);
  // Idempotent by machine name: calling create twice is how an importer starts.
  // Note it does NOT re-kind an existing vocabulary — flipping "categories"
  // back to "tags" by accident would silently disarm the guard.
  const existing = await store.first<VocabularyRow>(VOCABULARIES.byName, [name]);
  if (existing) return existing;

  const id = newId("vocab");
  await store.run(VOCABULARIES.insert, [
    id,
    name,
    input.label ?? input.name,
    input.description ?? "",
    input.kind === "categories" ? "categories" : "tags",
    nowIso(),
  ]);
  return (await store.first<VocabularyRow>(VOCABULARIES.byId, [id]))!;
}

export async function listVocabularies(store: Store): Promise<VocabularyRow[]> {
  return await store.all<VocabularyRow>(VOCABULARIES.list);
}

export async function createTerm(
  store: Store,
  input: {
    vocabulary: string;
    name: string;
    description?: string;
    parent_id?: string;
    weight?: number;
    /** Set only when this call may create the vocabulary too. */
    vocabularyKind?: VocabularyKind;
  },
): Promise<TermRow> {
  // Naming a vocabulary that does not exist creates it. The alternative is an
  // error every caller would answer by making it and retrying.
  const vocab = await createVocabulary(store, {
    name: input.vocabulary,
    kind: input.vocabularyKind,
  });
  const existing = await store.first<TermRow>(TERMS.byVocabAndName, [vocab.id, input.name]);
  if (existing) return existing;

  const id = newId("term");
  await store.run(TERMS.insert, [
    id,
    vocab.id,
    input.name,
    input.description ?? "",
    input.parent_id ?? null,
    input.weight ?? 0,
    nowIso(),
  ]);
  return (await store.first<TermRow>(TERMS.byId, [id]))!;
}

/**
 * Resolve a term for TAGGING, honouring the vocabulary's kind.
 *
 * Free-tagging creates what is missing. A controlled vocabulary refuses, and
 * says which terms it does have — an error a model can act on beats a silently
 * invented synonym it will never notice.
 */
export async function resolveTermForTagging(
  store: Store,
  vocabularyName: string,
  termName: string,
): Promise<TermRow> {
  const slug = slugify(vocabularyName);
  const vocab = await store.first<VocabularyRow>(VOCABULARIES.byName, [slug]);

  if (vocab?.kind === "categories") {
    const existing = await store.first<TermRow>(TERMS.byVocabAndName, [vocab.id, termName]);
    if (existing) return existing;
    const available = await store.all<TermRow>(TERMS.listInVocabulary, [slug]);
    throw new Error(
      `"${termName}" is not a term in the controlled vocabulary "${slug}". ` +
        `Available: ${available.map((t) => t.name).join(", ") || "(none yet)"}. ` +
        `Add it deliberately with term_create, or use a free-tagging vocabulary.`,
    );
  }

  return await createTerm(store, { vocabulary: vocabularyName, name: termName });
}

export async function setTermWeight(store: Store, termId: string, weight: number): Promise<TermRow | null> {
  await store.run(TERMS.setWeight, [Math.trunc(weight), termId]);
  return await store.first<TermRow>(TERMS.byId, [termId]);
}

export async function listTerms(store: Store, vocabulary?: string): Promise<TermRow[]> {
  if (vocabulary) {
    return await store.all<TermRow>(TERMS.listInVocabulary, [slugify(vocabulary)]);
  }
  return await store.all<TermRow>(TERMS.list);
}

export async function tagNode(store: Store, nodeId: string, termIds: string[]): Promise<number> {
  if (termIds.length === 0) return 0;
  const results = await store.batch(
    termIds.map((termId) => ({ sql: NODE_TERMS.tag, args: [nodeId, termId] })),
  );
  return results.reduce((sum, r) => sum + r.changes, 0);
}

export async function untagNode(store: Store, nodeId: string, termIds: string[]): Promise<number> {
  if (termIds.length === 0) return 0;
  const results = await store.batch(
    termIds.map((termId) => ({ sql: NODE_TERMS.untag, args: [nodeId, termId] })),
  );
  return results.reduce((sum, r) => sum + r.changes, 0);
}

export async function termsForNode(
  store: Store,
  nodeId: string,
): Promise<Array<TermRow & { vocabulary: string }>> {
  return await store.all<TermRow & { vocabulary: string }>(NODE_TERMS.forNode, [nodeId]);
}

// ── call log ─────────────────────────────────────────────────────────────────

/** Big enough to read, small enough that a runaway client cannot fill the disk. */
const MAX_LOG_FIELD = 4000;

export interface CallRecord {
  tool: string;
  input: unknown;
  outcome: "ok" | "error";
  result: unknown;
  duration_ms: number;
  client: string;
  /** The gate's `method:principal` (PRD §3.2, migration 0009). Empty on an open server. */
  method?: string;
  principal?: string;
}

/**
 * Best-effort, never blocking the answer. If logging fails the tool call still
 * returns — an audit trail that can take down the thing it audits is worse than
 * no audit trail.
 */
export async function logCall(store: Store, record: CallRecord, clock?: Clock): Promise<void> {
  try {
    await store.run(CALLS.insert, [
      newId("call"),
      nowIso(clock),
      record.tool,
      clip(record.input, MAX_LOG_FIELD),
      record.outcome,
      clip(record.result, MAX_LOG_FIELD),
      Math.round(record.duration_ms),
      record.client.slice(0, 200),
      record.method ?? "",
      record.principal ?? "",
    ]);
  } catch {
    // Deliberately swallowed. See above.
  }
}

export async function listCalls(
  store: Store,
  opts: { tool?: string; outcome?: string; limit?: number } = {},
): Promise<CallLogRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.tool) {
    where.push(CALL_WHERE.tool);
    args.push(opts.tool);
  }
  if (opts.outcome) {
    where.push(CALL_WHERE.outcome);
    args.push(opts.outcome);
  }
  args.push(clampLimit(opts.limit, 20, 200));
  return await store.all<CallLogRow>(listCallsSql(where), args);
}

export async function callStats(store: Store): Promise<Array<Record<string, unknown>>> {
  return await store.all<Record<string, unknown>>(CALLS.stats);
}

// ── protocol versions seen (PRD §3.4) ────────────────────────────────────────
//
// Logged, never echoed: `initialize` is not a tools/call, so mcp_calls never
// saw it. A settings row keeps the distinct values so /api/health can list
// what claude.ai and Claude Code actually send — the unmeasured risk is a
// value newer than the newest we know, and a log measures it.

const PROTOCOL_VERSIONS_KEY = "protocol_versions_seen";
const MAX_PROTOCOL_VERSIONS = 32;

export async function protocolVersionsSeen(store: Store): Promise<string[]> {
  try {
    const row = await store.first<{ value: string }>(SETTINGS.get, [PROTOCOL_VERSIONS_KEY]);
    const parsed = row ? JSON.parse(row.value) : [];
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Best-effort, like logCall: a handshake never fails because a note did. */
export async function noteProtocolVersion(store: Store, version: string, clock?: Clock): Promise<void> {
  try {
    const value = String(version ?? "").slice(0, 32);
    if (!value) return;
    const seen = await protocolVersionsSeen(store);
    if (seen.includes(value) || seen.length >= MAX_PROTOCOL_VERSIONS) return;
    await store.run(SETTINGS.put, [PROTOCOL_VERSIONS_KEY, JSON.stringify([...seen, value]), nowIso(clock)]);
  } catch {
    // Deliberately swallowed. See above.
  }
}

// ── corpus stats ─────────────────────────────────────────────────────────────

/** The content-type registry, derived rather than stored. */
export async function listTypes(store: Store): Promise<Array<{ type: string; count: number; newest: string }>> {
  return await store.all<{ type: string; count: number; newest: string }>(TYPES.list);
}

/**
 * The optional guard on `type`, reusing the taxonomy machinery instead of
 * growing a second one.
 *
 * If a CONTROLLED vocabulary named `type` exists, a node's type must be one of
 * its terms. If it does not exist, type stays free text. That is the same
 * tags-vs-categories policy applied to a different field, and it means the way
 * to lock down content types is the way you already know.
 */
/** "free" or "controlled" — so a caller can see whether the guard is armed. */
export async function typePolicy(store: Store): Promise<"free" | "controlled"> {
  const vocab = await store.first<VocabularyRow>(VOCABULARIES.byName, ["type"]);
  return vocab?.kind === "categories" ? "controlled" : "free";
}

export async function assertTypeAllowed(store: Store, type: string): Promise<void> {
  const vocab = await store.first<VocabularyRow>(VOCABULARIES.byName, ["type"]);
  if (vocab?.kind !== "categories") return; // free text, by absence of a policy
  const existing = await store.first<TermRow>(TERMS.byVocabAndName, [vocab.id, type]);
  if (existing) return;
  const available = await store.all<TermRow>(TERMS.listInVocabulary, ["type"]);
  throw new Error(
    `"${type}" is not an allowed content type. Available: ${available.map((t) => t.name).join(", ") || "(none yet)"}. ` +
      `Add it with term_create{vocabulary:"type"}, or delete the controlled "type" vocabulary to allow free text.`,
  );
}

export async function stats(store: Store): Promise<Record<string, unknown>> {
  const nodes = await store.first<{
    total: number;
    published: number;
    oldest: string | null;
    newest: string | null;
  }>(STATS.nodes);
  const byType = await store.all<{ type: string; count: number }>(STATS.byType);
  const vocabularies = await store.all<{ name: string; terms: number }>(STATS.vocabularies);
  return {
    nodes: nodes?.total ?? 0,
    published: nodes?.published ?? 0,
    oldest: nodes?.oldest ?? null,
    newest: nodes?.newest ?? null,
    by_type: byType,
    vocabularies,
  };
}

// ── semantic search ──────────────────────────────────────────────────────────
//
// Kept as its own section, and its own table, because embedding is a SECOND
// PHASE. Nothing above this line knows or cares whether vectors exist.

import { cosine, embedText, packVector, textHash, unpackVector } from "./embed";
import { TIMELINE, VECTORS } from "./sql";

export interface EmbedResult {
  embedded: number;
  failed: number;
  space: string | null;
  /** Present when the embedder was unavailable — the reason, not a silence. */
  error?: string;
}

/**
 * Embed one node. Best-effort by contract: a caller may ignore the result.
 * Never throws for provider problems — a write must not fail because a model is
 * down. Returns false when nothing was stored, so a caller CAN check.
 */
export async function embedNode(
  store: Store,
  embedder: Embedder,
  node: NodeRow,
): Promise<boolean> {
  try {
    const text = embedText(node.title, node.body);
    const [vector] = await embedder.embed([text]);
    if (!vector) return false;
    await store.run(VECTORS.upsert, [
      node.id,
      embedder.space,
      embedder.dim,
      packVector(vector),
      await textHash(text),
      nowIso(),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Backfill: embed nodes that have no vector in this space yet. */
export async function embedMissing(
  store: Store,
  embedder: Embedder,
  limit = 25,
): Promise<EmbedResult> {
  const pending = await store.all<NodeRow>(VECTORS.missing, [embedder.space, clampLimit(limit, 25, 200)]);
  let embedded = 0;
  let failed = 0;
  for (const node of pending) {
    // One at a time so a single bad row cannot lose the whole batch — the
    // fleet's own lesson from 29,372 embeddings buffered and then dropped by
    // one schema error at the end.
    (await embedNode(store, embedder, node)) ? embedded++ : failed++;
  }
  return { embedded, failed, space: embedder.space };
}

export interface SemanticHit extends NodeRow {
  score: number;
}

/**
 * Brute-force cosine over one space.
 *
 * No ANN, deliberately: this fleet measured the crossover at 2,000-20,000
 * vectors, and a corpus below it pays index complexity for nothing. If this
 * corpus ever passes that, the honest fix is an index, not a bigger loop.
 */
export async function semanticSearch(
  store: Store,
  embedder: Embedder,
  query: string,
  limit = 20,
): Promise<{ hits: SemanticHit[]; coverage: { nodes: number; embedded: number } }> {
  const coverage = await embeddingCoverage(store, embedder);
  const [queryVector] = await embedder.embed([query]);
  if (!queryVector) return { hits: [], coverage };

  const rows = await store.all<NodeRow & { vector: ArrayBuffer | Uint8Array | number[] }>(VECTORS.allInSpace, [
    embedder.space,
    embedder.dim,
  ]);

  const scored = rows.map((row) => {
    const { vector, ...node } = row;
    return { ...(node as NodeRow), score: cosine(queryVector, unpackVector(vector)) };
  });
  scored.sort((a, b) => b.score - a.score);
  return { hits: scored.slice(0, clampLimit(limit, 20, 100)), coverage };
}

export async function embeddingCoverage(
  store: Store,
  embedder: Embedder | null,
): Promise<{ nodes: number; embedded: number; spaces: number; space: string | null }> {
  const row = await store.first<{ nodes: number; embedded: number; spaces: number }>(
    VECTORS.coverage,
    [embedder?.space ?? ""],
  );
  return {
    nodes: row?.nodes ?? 0,
    embedded: row?.embedded ?? 0,
    spaces: row?.spaces ?? 0,
    space: embedder?.space ?? null,
  };
}


export interface TimelineEvent {
  /** `trace` is the third arm (PRD §3.7): a read that carried an intent. */
  kind: "node" | "call" | "trace";
  id: string;
  at: string;
  label: string;
  detail: string | null;
  outcome: string | null;
  duration_ms: number | null;
}

/**
 * Every event, newest first, both kinds interleaved.
 *
 * Deliberately NOT two lists the client zips together: doing the merge in SQL is
 * what lets the tiebreaker be `rowid`, which the client cannot see and which is
 * the only thing that makes same-millisecond events deterministically ordered.
 */
export async function timeline(store: Store, limit = 80): Promise<TimelineEvent[]> {
  const rows = await store.all<Record<string, unknown>>(TIMELINE.recent, [
    clampLimit(limit, 80, 300),
  ]);
  return rows.map((r) => ({
    kind: r.kind === "call" ? "call" : r.kind === "trace" ? "trace" : "node",
    id: String(r.id),
    at: String(r.at),
    label: String(r.label ?? ""),
    detail: r.detail == null ? null : String(r.detail),
    outcome: r.outcome == null ? null : String(r.outcome),
    duration_ms: r.duration_ms == null ? null : Number(r.duration_ms),
  }));
}


export interface VocabularyImpact {
  terms: number;
  assignments: number;
}

/** What deleting this vocabulary would take with it. Reported before, not after. */
export async function vocabularyImpact(store: Store, name: string): Promise<VocabularyImpact | null> {
  const vocabulary = await store.first<VocabularyRow>(VOCABULARIES.byName, [name]);
  if (!vocabulary) return null;
  const row = await store.first<{ terms: number; assignments: number }>(VOCABULARIES.impact, [
    vocabulary.id,
  ]);
  return { terms: Number(row?.terms ?? 0), assignments: Number(row?.assignments ?? 0) };
}

/**
 * The escape hatch the error messages have been promising.
 *
 * `assertTypeAllowed` tells a caller to "delete the controlled type vocabulary
 * to allow free text", and until now nothing in this codebase could do that —
 * the advice named an operation that did not exist, so the only real way out was
 * raw SQL against D1. That is the kind of gap a reader only finds by trying to
 * follow their own error message.
 *
 * Refuses by default when terms would be lost. Cascades are silent by design in
 * SQLite, and "delete the vocabulary" reads much cheaper than "delete every tag
 * anyone ever applied from it", which is what it actually means.
 */
export async function deleteVocabulary(
  store: Store,
  name: string,
  force = false,
): Promise<VocabularyImpact> {
  const vocabulary = await store.first<VocabularyRow>(VOCABULARIES.byName, [name]);
  if (!vocabulary) throw new Error(`no vocabulary named "${name}"`);

  const impact = (await vocabularyImpact(store, name))!;
  if (!force && (impact.terms > 0 || impact.assignments > 0)) {
    throw new Error(
      `deleting "${name}" would also delete ${impact.terms} term(s) and ${impact.assignments} tag assignment(s). ` +
        `Pass force to confirm.`,
    );
  }

  await store.run(VOCABULARIES.delete, [vocabulary.id]);
  return impact;
}
