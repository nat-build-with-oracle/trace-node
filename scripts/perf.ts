#!/usr/bin/env bun
/**
 * 1b-6 — the 500 k-trace fixture and its measurements (PRD §8.1b, §10).
 *
 * Builds a FILE-backed store (never `:memory:` — a perf number from a store
 * that never touches disk is not a perf number) with traces spread over 90
 * days across 5 000 distinct `keyword_norm`s (Zipf-ish: a handful of hot
 * keywords carry most of the volume, a long tail carries almost none — the
 * shape a real deployment has, not a uniform one an index could cheat on),
 * 100 k `mcp_calls`, 20 000 nodes/terms, ~1 000 connections and enough `digs`
 * to sit past its cap — then runs the REAL code paths against it:
 *
 *   - EXPLAIN QUERY PLAN for /api/cloud (each window) and every query the dig
 *     bundle issues, watching specifically for a SCAN on traces/trace_days/digs
 *     (PRD: "must show index use") and reporting the terms/mcp_calls arms as
 *     the known-unindexed ones the budget watches, not a defect.
 *   - wall-clock GET /api/cloud?window=7d and one POST /api/dig, through the
 *     real Elysia app (`app.fetch`), not the bare function — the HTTP layer's
 *     own overhead is part of what a caller waits on.
 *   - wall-clock janitor() at the caps, with the fixture built past every cap
 *     so eviction is exercised for real, not skipped because nothing was due.
 *     Runs FIRST in code (before any EXPLAIN/HTTP query touches the
 *     connection) — measured: an EXPLAIN QUERY PLAN of the recursive `/api/
 *     cloud` query at this scale can leave bun:sqlite holding a WAL read lock
 *     that makes the checkpoint step fail; see the report's own note. This
 *     also means every measurement below runs against a store sitting
 *     exactly at the caps.
 *   - the db (+ WAL) file size before and after that janitor run.
 *
 * Run: `just perf` (from the lab dir) or `bun scripts/perf.ts` (from app/).
 * Writes ../PERF-1b.md. Never run as part of `bun test` (pre-ruling 4) — this
 * takes tens of seconds to minutes, not milliseconds.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { createApp } from "../src/app";
import type { AuthMethod } from "../src/auth";
import { cutoffDay } from "../src/cloud";
import { escapeLike } from "../src/dig";
import { DEFAULT_CAPS, DEFAULT_RETENTION, janitor } from "../src/janitor";
import { CALLS, DIG, digGraphSql, digRelatedSql, NODE_TERMS, NODES, TERMS, TRACE_OF, TRACES, VOCABULARIES } from "../src/sql";
import { openSqliteStore } from "../src/store/sqlite";
import type { Store } from "../src/store/types";
import { keywordNorm } from "../src/trace";
import { newId } from "../src/utils";

// ── fixture sizes (PRD §8.1b / §10) ─────────────────────────────────────────
// PERF_SCALE divides every size for a fast smoke run (`PERF_SCALE=100 bun
// scripts/perf.ts`) — 1 (default) is the real 500 k/100 k/20 k fixture the PRD
// asks for; never leave a smoke value in a committed PERF-1b.md (the script
// stamps the scale used in the report so that can never happen silently).
const SCALE = Math.max(1, Number(process.env.PERF_SCALE) || 1);
const DAYS = 90;
const N_KEYWORDS = 5000;
const N_KEYWORD_SEARCH = Math.round(480_000 / SCALE);
const N_KEYWORD_DIG = Math.round(20_000 / SCALE);
const N_TERM_READS = Math.round(20_000 / SCALE);
const N_TRACES = N_KEYWORD_SEARCH + N_KEYWORD_DIG + N_TERM_READS; // 520 000 at scale 1 — past the 500 000 cap
const N_CALLS = Math.round(102_000 / SCALE); // past the 100 000 cap at scale 1
const N_DIGS = Math.round(52_000 / SCALE); // past the 50 000 cap at scale 1
const N_CONNECTIONS = Math.round(1_050 / SCALE); // past the 1 000 cap at scale 1
const N_NODES = Math.round(19_500 / SCALE);
const N_CATEGORY_ROOTS = 15;
const N_CATEGORY_CHILDREN = 9; // per root -> 135 category terms + 15 roots = 150
const N_TAGS = 350; // 150 + 350 = 500 terms; + 19 500 nodes = 20 000 at scale 1
const OUT_PATH_OVERRIDE = process.env.PERF_OUT;

// A frozen "now" — every window computation in the app reads this clock, so a
// perf number taken today is reproducible tomorrow.
const NOW = new Date("2026-09-07T04:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const clock = () => NOW;

const APP_DIR = join(import.meta.dir, "..");
const LAB_DIR = join(APP_DIR, "..");
const DB_PATH = join(APP_DIR, ".perf", "fixture.sqlite");
const OUT_PATH = OUT_PATH_OVERRIDE ?? join(LAB_DIR, "PERF-1b.md");

const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T,>(arr: readonly T[]): T => arr[rand(arr.length)]!;
const randomAt = (): Date => new Date(NOW.getTime() - rand(DAYS * DAY_MS));

// ── keyword pool: 10 realistic names at the head, 4 990 synthetic behind them ─
const NAMED_KEYWORDS = [
  "mcp",
  "trace-node",
  "dig",
  "oracle",
  "pocketbase",
  "home assistant",
  "sqlite",
  "bun",
  "p2p channel",
  "ingress",
] as const;
const KEYWORDS: string[] = [
  ...NAMED_KEYWORDS,
  ...Array.from({ length: N_KEYWORDS - NAMED_KEYWORDS.length }, (_, i) => `kw-${String(i + NAMED_KEYWORDS.length).padStart(4, "0")}`),
];

/** Zipf-ish weights (s=1.07) over KEYWORDS' rank order, as a cumulative table for O(log n) sampling. */
function zipfCumulative(n: number, s: number): Float64Array {
  const cum = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += 1 / (i + 1) ** s;
    cum[i] = total;
  }
  for (let i = 0; i < n; i++) cum[i] /= total;
  return cum;
}
const CUM = zipfCumulative(N_KEYWORDS, 1.07);
function zipfIndex(): number {
  const u = Math.random();
  let lo = 0;
  let hi = CUM.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (CUM[mid]! < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const METHODS: AuthMethod[] = ["oauth", "api-token", "ingress", "owner-session", "open"];
const principalFor = (method: AuthMethod): string =>
  method === "oauth" ? `client_${rand(20)}` : method === "ingress" ? `172.30.32.${2 + rand(3)}` : method === "api-token" ? "curl" : method === "owner-session" ? "browser" : "anonymous";
const CLIENTS = ["claude-ai", "claude-code/2.0", "curl/8.4.0", "trace-node-page", ""] as const;
const TOOLS = ["node_search", "dig", "node_create", "node_get", "term_list", "vocabulary_list", "node_update", "term_create", "status", "node_delete", "node_tag", "category_browse"] as const;
const WORDS = "the trace node keeps a memory of every read mcp oracle fleet dig cloud keyword term category home assistant ingress pocketbase evolve digger hybrid sqlite bun elysia gate janitor".split(" ");
const lorem = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");

async function run() {
  console.log(`1b-6 perf — machine m5, bun ${Bun.version}, ${process.platform}/${process.arch}`);
  console.log(`fixture: ${N_TRACES} traces, ${N_CALLS} mcp_calls, ${N_DIGS} digs, ${N_NODES + N_CATEGORY_ROOTS + N_CATEGORY_ROOTS * N_CATEGORY_CHILDREN + N_TAGS} nodes+terms, ${N_CONNECTIONS} connections`);

  if (existsSync(dirname(DB_PATH))) rmSync(dirname(DB_PATH), { recursive: true, force: true });
  Bun.spawnSync(["mkdir", "-p", dirname(DB_PATH)]);
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  }

  const migrationsDir = join(APP_DIR, "migrations");
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ name: file, sql: readFileSync(join(migrationsDir, file), "utf8") }));

  const store = await openSqliteStore(DB_PATH, migrations);
  // Bulk generation, not a live server: NORMAL is the documented safe pairing
  // with WAL (already set by openSqliteStore) and is what makes ~1M inserts
  // finish in seconds rather than minutes of fsync-per-commit.
  await store.run("PRAGMA synchronous = NORMAL");

  const sqliteVersion = (await store.first<{ v: string }>("SELECT sqlite_version() AS v"))?.v ?? "?";
  console.log(`sqlite ${sqliteVersion}`);

  const genStart = Date.now();

  // ── vocabularies + terms ───────────────────────────────────────────────────
  const catVocabId = newId("voc");
  const tagVocabId = newId("voc");
  await store.batch([
    { sql: VOCABULARIES.insert, args: [catVocabId, "topics", "Topics", "Perf fixture category vocabulary", "categories", NOW.toISOString()] },
    { sql: VOCABULARIES.insert, args: [tagVocabId, "tags", "Tags", "Perf fixture tag vocabulary", "tags", NOW.toISOString()] },
  ]);

  type TermSeed = { id: string; vocabId: string; kind: "categories" | "tags" };
  const terms: TermSeed[] = [];
  const termStmts: Array<{ sql: string; args: unknown[] }> = [];
  for (let r = 0; r < N_CATEGORY_ROOTS; r++) {
    const id = newId("term");
    terms.push({ id, vocabId: catVocabId, kind: "categories" });
    termStmts.push({ sql: TERMS.insert, args: [id, catVocabId, `Root ${r}`, "", null, r, NOW.toISOString()] });
    for (let c = 0; c < N_CATEGORY_CHILDREN; c++) {
      const cid = newId("term");
      terms.push({ id: cid, vocabId: catVocabId, kind: "categories" });
      termStmts.push({ sql: TERMS.insert, args: [cid, catVocabId, `Root ${r} / Child ${c}`, "", id, c, NOW.toISOString()] });
    }
  }
  const NAMED_TAGS = ["mcp", "trace-node", "dig", "oracle", "pocketbase"];
  for (let t = 0; t < N_TAGS; t++) {
    const id = newId("term");
    terms.push({ id, vocabId: tagVocabId, kind: "tags" });
    const name = t < NAMED_TAGS.length ? NAMED_TAGS[t]! : `tag-${String(t).padStart(4, "0")}`;
    termStmts.push({ sql: TERMS.insert, args: [id, tagVocabId, name, "", null, 0, NOW.toISOString()] });
  }
  await store.batch(termStmts);
  console.log(`terms: ${terms.length}`);

  // ── nodes + node_terms ─────────────────────────────────────────────────────
  const nodeIds: string[] = [];
  const NODE_CHUNK = 5000;
  for (let base = 0; base < N_NODES; base += NODE_CHUNK) {
    const chunk = Math.min(NODE_CHUNK, N_NODES - base);
    const stmts: Array<{ sql: string; args: unknown[] }> = [];
    for (let i = 0; i < chunk; i++) {
      const idx = base + i;
      const id = newId("node");
      nodeIds.push(id);
      const at = randomAt().toISOString();
      const title = idx % 37 === 0 ? `mcp notes ${idx}` : `Node ${idx} — ${lorem(3)}`;
      const body = lorem(20);
      stmts.push({ sql: NODES.insert, args: [id, "note", title, body, at, at, 1, "perf-fixture"] });
    }
    await store.batch(stmts);
  }
  console.log(`nodes: ${nodeIds.length}`);

  {
    const stmts: Array<{ sql: string; args: unknown[] }> = [];
    for (const nodeId of nodeIds) {
      const nTerms = Math.random() < 0.2 ? 2 : 1;
      for (let k = 0; k < nTerms; k++) stmts.push({ sql: NODE_TERMS.tag, args: [nodeId, pick(terms).id] });
    }
    const CHUNK = 10_000;
    for (let base = 0; base < stmts.length; base += CHUNK) await store.batch(stmts.slice(base, base + CHUNK));
    console.log(`node_terms: ${stmts.length}`);
  }

  // ── traces + trace_days (the same two statements recordTrace batches) ──────
  const TRACE_CHUNK = 8000;
  let written = 0;
  const writeTraceChunk = async (n: number, kind: () => string, subjectOf: () => { subject: "keyword" | "term"; key: string; keyword: string; vocabulary: string }) => {
    for (let base = 0; base < n; base += TRACE_CHUNK) {
      const count = Math.min(TRACE_CHUNK, n - base);
      const stmts: Array<{ sql: string; args: unknown[] }> = [];
      for (let i = 0; i < count; i++) {
        const method = pick(METHODS);
        const principal = principalFor(method);
        const haUser = method === "ingress" ? `ha_user_${rand(5)}` : "";
        const at = randomAt().toISOString();
        const s = subjectOf();
        const id = newId("tr");
        stmts.push({
          sql: TRACES.insert,
          args: [id, at, kind(), pick(["mcp", "http", "ui"]), method, principal, haUser, s.subject, s.key, s.keyword, keywordNorm(s.keyword) || s.key, null, s.subject === "term" ? s.key : null, s.vocabulary, 0, "", rand(40), pick(CLIENTS), null],
        });
        stmts.push({ sql: TRACES.upsertDay, args: [s.subject, s.key, at, 0, rand(40), at, s.subject === "keyword" ? s.keyword : ""] });
      }
      await store.batch(stmts);
      written += count;
      if (written % 80_000 < TRACE_CHUNK) process.stdout.write(`\r  traces: ${written}/${N_TRACES}`);
    }
  };
  await writeTraceChunk(N_KEYWORD_SEARCH, () => "search", () => {
    const kw = KEYWORDS[zipfIndex()]!;
    return { subject: "keyword", key: keywordNorm(kw), keyword: kw, vocabulary: "" };
  });
  await writeTraceChunk(N_KEYWORD_DIG, () => "dig", () => {
    const kw = KEYWORDS[zipfIndex()]!;
    return { subject: "keyword", key: keywordNorm(kw), keyword: kw, vocabulary: "" };
  });
  await writeTraceChunk(N_TERM_READS, () => (Math.random() < 0.5 ? "term" : "category"), () => {
    const t = pick(terms);
    return { subject: "term", key: t.id, keyword: "", vocabulary: t.vocabId === catVocabId ? "topics" : "tags" };
  });
  process.stdout.write("\n");
  console.log(`traces: ${written}`);

  // ── mcp_calls ────────────────────────────────────────────────────────────
  {
    const CHUNK = 10_000;
    let done = 0;
    for (let base = 0; base < N_CALLS; base += CHUNK) {
      const count = Math.min(CHUNK, N_CALLS - base);
      const stmts: Array<{ sql: string; args: unknown[] }> = [];
      for (let i = 0; i < count; i++) {
        const at = randomAt().toISOString();
        const method = pick(METHODS);
        const principal = principalFor(method);
        const mentionsKeyword = Math.random() < 0.15;
        const input = mentionsKeyword ? JSON.stringify({ q: pick(NAMED_KEYWORDS) }) : JSON.stringify({ q: `kw-${rand(9999)}`, limit: 10 });
        stmts.push({
          sql: CALLS.insert,
          args: [newId("call"), at, pick(TOOLS), input, Math.random() < 0.03 ? "error" : "ok", "{}", rand(120), pick(CLIENTS), method, principal],
        });
      }
      await store.batch(stmts);
      done += count;
    }
    console.log(`mcp_calls: ${done}`);
  }

  // ── digs ────────────────────────────────────────────────────────────────
  {
    const CHUNK = 10_000;
    let done = 0;
    for (let base = 0; base < N_DIGS; base += CHUNK) {
      const count = Math.min(CHUNK, N_DIGS - base);
      const stmts: Array<{ sql: string; args: unknown[] }> = [];
      for (let i = 0; i < count; i++) {
        const at = randomAt().toISOString();
        const method = pick(METHODS);
        const principal = principalFor(method);
        const kw = KEYWORDS[zipfIndex()]!;
        const norm = keywordNorm(kw);
        const confidence = pick(["high", "medium", "low"] as const);
        const friction = confidence === "high" ? 0 : confidence === "medium" ? 0.5 : 0.9;
        stmts.push({
          sql: DIG.insert,
          args: [at, kw, norm, method, principal, method === "ingress" ? `ha_user_${rand(5)}` : "", friction, confidence, "{}", "[]", rand(60)],
        });
      }
      await store.batch(stmts);
      done += count;
    }
    console.log(`digs: ${done}`);
  }

  // ── connections ──────────────────────────────────────────────────────────
  {
    const stmts: Array<{ sql: string; args: unknown[] }> = [];
    for (let i = 0; i < N_CONNECTIONS; i++) {
      const method = pick(METHODS);
      const principal = i < 50 ? `client_ancient_${i}` : `${principalFor(method)}_${i}`;
      const firstSeen = randomAt().toISOString();
      const lastSeen = randomAt().toISOString();
      stmts.push({
        sql: `INSERT INTO connections (id, method, principal, label, user_agent, remote_ip, first_seen, last_seen, requests, tool_calls, last_tool)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [`${method}:${principal}`, method, principal, `${method} · ${principal}`, pick(CLIENTS), method === "ingress" ? principal : null, firstSeen, lastSeen, rand(500), rand(50), pick(TOOLS)],
      });
    }
    await store.batch(stmts);
    console.log(`connections: ${stmts.length}`);
  }

  const genMs = Date.now() - genStart;
  console.log(`fixture built in ${genMs} ms`);

  const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0);
  const dbSizeAfterBuild = sizeOf(DB_PATH) + sizeOf(DB_PATH + "-wal") + sizeOf(DB_PATH + "-shm");

  // ── janitor at the caps — run FIRST, before any EXPLAIN/HTTP query on this
  // connection. Measured (1b-6): a `WITH RECURSIVE` query run through `EXPLAIN
  // QUERY PLAN` against this fixture's scale leaves bun:sqlite's cached
  // statement holding a WAL read snapshot that is never released (confirmed
  // with a standalone repro: the lock persists across two retries 200 ms
  // apart, so it is not a race) — and a checkpoint attempted afterward on the
  // SAME connection then fails with `SQLITE_LOCKED "database table is
  // locked"`. That is a property of the introspection query this SCRIPT
  // issues, not of any code path the server itself runs — trace-node never
  // executes `EXPLAIN QUERY PLAN` in production — so janitor runs here, first,
  // on a connection that has done nothing but writes, which is what its
  // real 10-minutely boot/timer invocation always looks like. A `### bun:sqlite
  // + EXPLAIN QUERY PLAN` note below the janitor table records the artifact
  // for the record rather than hiding it.
  console.log("running janitor() at DEFAULT_CAPS");
  const countAll = async () => ({
    traces: (await store.first<{ c: number }>("SELECT COUNT(*) AS c FROM traces"))?.c,
    trace_days: (await store.first<{ c: number }>("SELECT COUNT(*) AS c FROM trace_days"))?.c,
    digs: (await store.first<{ c: number }>("SELECT COUNT(*) AS c FROM digs"))?.c,
    mcp_calls: (await store.first<{ c: number }>("SELECT COUNT(*) AS c FROM mcp_calls"))?.c,
    connections: (await store.first<{ c: number }>("SELECT COUNT(*) AS c FROM connections"))?.c,
  });
  const beforeCounts = await countAll();
  const sizeBeforeJanitor = dbSizeAfterBuild;
  const janitorStart = performance.now();
  const report = await janitor(store, { clock, caps: DEFAULT_CAPS });
  const janitorMs = performance.now() - janitorStart;
  if (report.errors.length) console.log("janitor errors:", JSON.stringify(report.errors));
  const sizeAfterJanitor = sizeOf(DB_PATH) + sizeOf(DB_PATH + "-wal") + sizeOf(DB_PATH + "-shm");
  const afterCounts = await countAll();
  console.log(`janitor: ${janitorMs.toFixed(1)} ms, evicted ${JSON.stringify(report.evicted)}`);

  // Every measurement below now runs against a store sitting AT the caps
  // (traces = 500 000 exactly, digs = 50 000, mcp_calls = 100 000) — the
  // literal "at the caps" the PRD's dig-latency and EXPLAIN requirements name.

  // ── EXPLAIN QUERY PLAN ──────────────────────────────────────────────────
  const explainLines: string[] = [];
  const scanWarnings: string[] = [];
  const WATCHED = ["traces", "trace_days", "digs"];
  async function explainOne(label: string, sql: string, args: unknown[]) {
    const rows = await store.all<{ id: number; parent: number; notused: number; detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, args);
    explainLines.push(`### ${label}`, "```", ...rows.map((r) => r.detail), "```", "");
    for (const r of rows) {
      for (const table of WATCHED) {
        if (new RegExp(`\\bSCAN\\b[^\\n]*\\b${table}\\b`, "i").test(r.detail) && !/SEARCH/i.test(r.detail)) {
          scanWarnings.push(`${label}: "${r.detail}" scans ${table}`);
        }
      }
    }
  }

  console.log("EXPLAIN QUERY PLAN — /api/cloud (by=all, each window)");
  const dayOf = (d: Date) => d.toISOString().slice(0, 10);
  for (const [window, halfLife] of [["24h", 1], ["7d", 7], ["all", 0]] as const) {
    const { cloudSql } = await import("../src/sql");
    await explainOne(`/api/cloud?by=all&window=${window}`, cloudSql("all", window), [dayOf(NOW), halfLife, cutoffDay(window, NOW), 0, 60]);
  }

  console.log("EXPLAIN QUERY PLAN — the dig bundle (keyword=mcp, window=all)");
  const digKeyword = "mcp";
  const norm = keywordNorm(digKeyword);
  const escaped = escapeLike(norm);
  const dayCutoff = cutoffDay("all", NOW);
  const rowCutoff = "";
  const callsCutoff = new Date(NOW.getTime() - DEFAULT_RETENTION.callsDays * DAY_MS).toISOString();
  const budgetCutoff = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
  await explainOne("dig: terms exact", DIG.termsExact, [norm]);
  await explainOne("dig: terms like", DIG.termsLike, [escaped, norm, 10]);
  await explainOne("dig: traces totals (trace_days)", TRACE_OF.totals, ["keyword", norm, dayCutoff]);
  await explainOne("dig: traces days (trace_days)", TRACE_OF.days, ["keyword", norm, dayCutoff]);
  await explainOne("dig: traces by_kind (traces)", TRACE_OF.byKind, ["keyword", norm, rowCutoff]);
  await explainOne("dig: traces by_method (traces)", TRACE_OF.byMethod, ["keyword", norm, rowCutoff]);
  await explainOne("dig: traces principals (traces)", TRACE_OF.principals, ["keyword", norm, rowCutoff]);
  await explainOne("dig: calls (mcp_calls, bounded by called_at)", DIG.calls, [escaped, callsCutoff, 20]);
  await explainOne("dig: prior digs (digs)", DIG.prior, [norm, 10]);
  await explainOne("dig: budget count (digs)", DIG.budgetCount, ["api-token", "curl", budgetCutoff]);
  await explainOne("dig: budget oldest (digs)", DIG.budgetOldest, ["api-token", "curl", budgetCutoff, 59]);
  const exact = await store.all<{ id: string }>(DIG.termsExact, [norm]);
  const exactIds = exact.map((t) => t.id);
  if (exactIds.length) {
    await explainOne("dig: graph reach (node_terms)", digGraphSql(exactIds.length), [...exactIds, 30]);
    await explainOne("dig: related terms (node_terms)", digRelatedSql(exactIds.length), [...exactIds, ...exactIds, 10]);
  }

  // ── wall-clock: through the real HTTP app ──────────────────────────────
  const API_TOKEN = "perf-static-token-not-a-secret-default";
  const app = createApp({ store, instanceName: "trace-node-perf", auth: { apiToken: API_TOKEN }, clock });
  const hdr = { authorization: `Bearer ${API_TOKEN}` };
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...hdr, ...(init.headers ?? {}) } }));

  const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  // Nearest-rank percentile — deterministic, no interpolation surprises for a
  // handful of samples. p in [0,100].
  const pctl = (xs: number[], p: number) => {
    const sorted = xs.slice().sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)]!;
  };

  console.log("timing GET /api/cloud?window=7d ×7");
  const cloudTimes: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    const res = await req("/api/cloud?window=7d&by=all&limit=60");
    await res.json();
    cloudTimes.push(performance.now() - t0);
  }

  // Hot-keyword dig: the one number PRD §3.6's "< 200 ms at the caps" budget
  // is measured against. 1b-6's verifier found the original n=7 wall-clock
  // sample too small to tell a real distribution from noise — a same-recipe
  // rerun 2.5 min after the committed run hit 203.7 ms while the committed
  // run's own max was 187.8 ms, same server, same fixture shape. Fixed here:
  // 3 untimed warm-ups (JIT/statement-cache settle before anything is
  // counted), then DIG_HOT_N (default 50, override with PERF_DIG_HOT_N)
  // timed requests, reported as p50/p95/max plus the raw count at-or-over
  // 200 ms — not median-and-max alone, which hides exactly the tail a
  // caller's *actual* wait time lives in.
  const DIG_HOT_N = Math.max(7, Number(process.env.PERF_DIG_HOT_N) || 50);
  console.log("warming up POST /api/dig ×3 (hot keyword 'mcp', window=all) — untimed");
  for (let i = 0; i < 3; i++) {
    await req("/api/dig", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "mcp", window: "all" }) });
  }
  console.log(`timing POST /api/dig ×${DIG_HOT_N} (hot keyword 'mcp', window=all)`);
  const digTimes: number[] = [];
  const digTookMsSamples: number[] = [];
  for (let i = 0; i < DIG_HOT_N; i++) {
    const t0 = performance.now();
    const res = await req("/api/dig", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "mcp", window: "all" }) });
    const body = (await res.json()) as { took_ms?: number };
    digTookMsSamples.push(body.took_ms ?? -1);
    digTimes.push(performance.now() - t0);
  }
  const lastDigTookMs = digTookMsSamples[digTookMsSamples.length - 1] ?? -1;
  const digOverBudget = digTimes.filter((t) => t >= 200).length;

  console.log("timing POST /api/dig ×3 (cold keyword, window=all)");
  const coldDigTimes: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const res = await req("/api/dig", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: `kw-${9000 + i}`, window: "all" }) });
    await res.json();
    coldDigTimes.push(performance.now() - t0);
  }

  // ── write PERF-1b.md ──────────────────────────────────────────────────────
  const fmtMs = (n: number) => `${n.toFixed(1)} ms`;
  const md = `# PERF-1b — the 500 k-trace fixture (PRD §8.1b, §10)

Measured ${new Date().toISOString()} on m5 (${process.platform}/${process.arch}), bun ${Bun.version}, sqlite ${sqliteVersion}.${SCALE !== 1 ? `\n\n**PERF_SCALE=${SCALE} — this is a SMOKE run, not the real fixture. Not a §8.1b/§10 measurement.**` : ""}
File store at \`app/.perf/fixture.sqlite\` (gitignored, \`*.sqlite\`) — never \`:memory:\`; generated fresh by \`scripts/perf.ts\`, never committed.

## Fixture

| table | rows | note |
|---|---:|---|
| traces | ${written} | ${N_KEYWORD_SEARCH} keyword search + ${N_KEYWORD_DIG} keyword dig + ${N_TERM_READS} term/category, 5 000 distinct \`keyword_norm\`s, Zipf-ish (s=1.07) over 90 days ending ${NOW.toISOString()} |
| trace_days | ${(await store.first<{ c: number }>("SELECT COUNT(*) AS c FROM trace_days"))?.c} | never evicted — the projection |
| mcp_calls | ${N_CALLS} | 90-day spread, ~15% of \`input\` mention a hot keyword (exercises the LIKE arm) |
| digs | ${N_DIGS} | past the 50 000 cap on purpose, to exercise eviction below |
| connections | ${N_CONNECTIONS} | past the 1 000 cap |
| nodes | ${nodeIds.length} | trigram FTS populated via the real \`nodes_fts\` triggers |
| terms | ${terms.length} | 150 categories (15 roots × 9 children) + 350 tags, incl. \`mcp\`, \`trace-node\`, \`dig\`, \`oracle\`, \`pocketbase\` |
| node_terms | tagged ~1.2× nodes | |

Fixture build: **${(genMs / 1000).toFixed(1)} s**. DB (+WAL) file size after build: **${(dbSizeAfterBuild / (1024 * 1024)).toFixed(1)} MB**.

## EXPLAIN QUERY PLAN

PRD §8.1b requires index use — \`SEARCH\` not \`SCAN\` — specifically on \`traces\`, \`trace_days\` and \`digs\`.
\`terms\` (20 000 rows) and \`mcp_calls\`'s \`input LIKE\` are the **known**, budget-watched unindexed arms
(PRD §3.6: "the \`mcp_calls\` and \`terms LIKE\` arms are the unindexed scans the budget watches") — a scan
there is not a defect, only \`mcp_calls\` must be *bounded* by the \`called_at\` index first.

${explainLines.join("\n")}

${
  scanWarnings.length === 0
    ? "**No SCAN found on `traces`, `trace_days` or `digs` in any plan above.**"
    : `**SCAN found on a watched table — fixed below (migration 0010):**\n\n${scanWarnings.map((w) => `- ${w}`).join("\n")}`
}

## Wall-clock (through the real \`app.fetch\` HTTP path, 127.0.0.1 in-process — no network)

The hot-keyword dig row is preceded by 3 untimed warm-up requests (JIT / statement-cache settle,
not counted). \`p95\`/\`p99\` are nearest-rank over the sample.

| call | n | p50 | p95 | p99 | max | min |
|---|---:|---:|---:|---:|---:|---:|---:|
| \`GET /api/cloud?window=7d&by=all\` | ${cloudTimes.length} | ${fmtMs(median(cloudTimes))} | ${fmtMs(pctl(cloudTimes, 95))} | ${fmtMs(pctl(cloudTimes, 99))} | ${fmtMs(Math.max(...cloudTimes))} | ${fmtMs(Math.min(...cloudTimes))} |
| \`POST /api/dig\` {q:"mcp", window:"all"} (hot keyword) | ${digTimes.length} | ${fmtMs(median(digTimes))} | ${fmtMs(pctl(digTimes, 95))} | ${fmtMs(pctl(digTimes, 99))} | ${fmtMs(Math.max(...digTimes))} | ${fmtMs(Math.min(...digTimes))} |
| \`POST /api/dig\` (cold keyword) | ${coldDigTimes.length} | ${fmtMs(median(coldDigTimes))} | ${fmtMs(pctl(coldDigTimes, 95))} | ${fmtMs(pctl(coldDigTimes, 99))} | ${fmtMs(Math.max(...coldDigTimes))} | ${fmtMs(Math.min(...coldDigTimes))} |

### Budget verdict (PRD §3.6, ambiguity resolved per pre-ruling 8)

PRD §3.6: "a dig at the caps (500 k traces, 100 k calls) must answer in **< 200 ms** on m5". The PRD
does not say whether that 200 ms is the server's own DB-work time or the full round trip a caller
(an HA add-on, the page, an MCP client) actually waits on. **Ruling, recorded here**: per pre-ruling 8
(ambiguity → the stricter reading), **the full wall-clock round trip — HTTP parse, handler, JSON
serialize, all of it — is the number the budget is measured against**, not the server-side \`took_ms\`,
because that is what every real caller experiences; \`took_ms\` is reported below only as a diagnostic
breakdown of where the time goes, never as the budget's own number.

Last hot-keyword dig's own \`took_ms\` (server-measured, DB work only, excludes HTTP/JSON overhead):
**${lastDigTookMs} ms**.

Under the wall-clock reading, across ${digTimes.length} hot-keyword digs at the caps: p50
**${fmtMs(median(digTimes))}**, p95 **${fmtMs(pctl(digTimes, 95))}**, max **${fmtMs(Math.max(...digTimes))}**;
**${digOverBudget}/${digTimes.length}** samples were **≥ 200 ms**.

${
  digOverBudget === 0
    ? `**VERDICT: PASS.** Every one of ${digTimes.length} hot-keyword wall-clock round trips at the caps was under 200 ms; the budget is met under the stricter (wall-clock) reading, not only under the looser \`took_ms\` reading.`
    : `**VERDICT: MISS, recorded honestly.** ${digOverBudget} of ${digTimes.length} hot-keyword wall-clock round trips at the caps hit or exceeded 200 ms (max ${fmtMs(Math.max(...digTimes))}). The server-side \`took_ms\` (~${lastDigTookMs} ms) stays comfortably under budget — the overrun is HTTP/JSON/event-loop overhead on top of it, on the order of ${fmtMs(Math.max(...digTimes) - lastDigTookMs)} at the worst sample seen here. This is a real gap against the stricter reading, not a rounding error: on m5, at the caps, a caller who counts the whole round trip cannot be promised under 200 ms every time. Not chased further at gate 1b (no code changed by this run) — a fix would mean cutting HTTP/JSON overhead or the DB work itself, which is gate-2/optimization scope, not this fixture's job. The looser (\`took_ms\`-only) reading would report a clean pass; this report does not take that reading.`
}

## janitor() at the caps

Fixture was built **past every cap** on purpose (traces ${N_TRACES} > 500 000, digs ${N_DIGS} > 50 000,
mcp_calls ${N_CALLS} > 100 000, connections ${N_CONNECTIONS} > 1 000) so this run evicts for real. Run
**first**, before any other measurement touched this connection (see the note below) — every EXPLAIN and
wall-clock number after this point is therefore measured against a store sitting **exactly** at the caps
(traces = 500 000, digs = 50 000, mcp_calls = 100 000), the literal reading of "at the caps".

| table | before | after | evicted |
|---|---:|---:|---:|
| traces | ${beforeCounts.traces} | ${afterCounts.traces} | ${report.evicted.traces} |
| trace_days | ${beforeCounts.trace_days} | (never evicted) | 0 |
| digs | ${beforeCounts.digs} | ${afterCounts.digs} | ${report.evicted.digs} |
| mcp_calls | ${beforeCounts.mcp_calls} | ${afterCounts.mcp_calls} | ${report.evicted.calls} |
| connections | ${beforeCounts.connections} | ${afterCounts.connections} | ${report.evicted.connections} |

janitor() wall-clock: **${fmtMs(janitorMs)}**. Warned: ${report.warned ? "**yes** — " + JSON.stringify(report.warned) : "no"}.
data_free_mb: ${report.data_free_mb ?? "null (no dataDir passed)"}. Checkpointed: **${report.checkpointed ? "yes" : "no"}**.
${report.errors.length ? `Errors this run: ${JSON.stringify(report.errors)}.` : "No errors this run."}

### DB file size, before/after janitor

| | size (db + WAL + SHM) |
|---|---:|
| before janitor | ${(sizeBeforeJanitor / (1024 * 1024)).toFixed(1)} MB |
| after janitor | ${(sizeAfterJanitor / (1024 * 1024)).toFixed(1)} MB |

Honest, per PRD §3.8: **no VACUUM in v1**. Deleted rows free pages *inside* the file; ${report.checkpointed ? "a checkpoint (triggered here — janitor's own `> 1 000 rows deleted → PRAGMA wal_checkpoint(PASSIVE)` rule) folds the WAL back into the main file, which is" : "the checkpoint this run did **not** run (see below), so the WAL simply grew instead of folding back — either way this is"} why the main file does not shrink even though rows are gone — DOCS.md's "run VACUUM by hand after \`ha addons stop\`" is the only way to reclaim the space.

### Found: \`EXPLAIN QUERY PLAN\` + a big \`wal_checkpoint\` can deadlock the SAME bun:sqlite connection

Not a defect in trace-node's own code — the server never runs \`EXPLAIN QUERY PLAN\` against itself — but
worth recording because this SCRIPT does, and it is exactly the kind of interaction a perf harness exists
to catch. Reproduced standalone, twice, deterministically: build this fixture's full 520 000/102 000/52 000
rows on one connection, run the sixteen \`EXPLAIN QUERY PLAN\` statements below (in particular the
\`WITH RECURSIVE\` \`/api/cloud\` query) on that SAME connection, then call \`janitor()\` — its
\`PRAGMA wal_checkpoint(PASSIVE)\` step throws \`SQLITE_LOCKED "database table is locked"\`, caught by
janitor's own "never throws" contract and recorded in \`report.errors\`, never crashing the process. The
lock does **not** clear with time: a manual retry immediately after, and again 200 ms later, both still fail
— so it is a held statement, not a race. Doing the data generation alone, or the generation plus the full
wall-clock HTTP round (\`app.fetch\` GET /api/cloud + POST /api/dig ×14), on the same connection and then
checkpointing, does **not** reproduce it — only the \`EXPLAIN QUERY PLAN\` calls do. This script now runs
janitor() BEFORE any EXPLAIN (above), which both avoids the artifact and gives every later measurement a
store sitting exactly at the caps. **Not proven**: whether this is a bun:sqlite statement-cache issue
specific to \`EXPLAIN QUERY PLAN\` on a \`WITH RECURSIVE\` statement, or something narrower; not chased
further here since production never runs this query shape against itself.

## Machine

m5, ${process.platform}/${process.arch}, bun ${Bun.version}, sqlite ${sqliteVersion} (bundled with bun, not the OS's).
`;

  await Bun.write(OUT_PATH, md);
  console.log(`wrote ${OUT_PATH}`);
  if (scanWarnings.length) {
    console.log("SCAN WARNINGS:");
    for (const w of scanWarnings) console.log(`  ${w}`);
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
