/**
 * The dig (PRD §3.6): everything the node knows about X, with provenance.
 *
 * Twelve tests, the §8.1a row: tier scores (exact term 100, graph reach 20,
 * prior dig 12 with its dig_seq), the four friction tiers, a monotonic and
 * unique dig_seq over 100 digs, `top` ≤ 5, `as_of`/`dug_by` on a frozen clock,
 * LIKE escaping of `%` `_` `\`, `nodes_vector === null` without an embedder,
 * `include` switching every source off, `GET /api/dig` → 405, and the budget:
 * the 61st dig in ten minutes is refused.
 *
 * Every dig is also checked as the write it is — one `digs` row, one trace of
 * kind `dig` carrying the same dig_seq — because a dig that forgot to leave
 * its own footprint would be the one read the cloud never learns from.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createApp } from "../src/app";
import type { AuthConfig } from "../src/auth";
import { CONFIDENT_FLOOR, DIG_BUDGET, DIG_SOURCES, escapeLike, friction, parseInclude, SCORE } from "../src/dig";
import type { Embedder } from "../src/embed";
import { openSqliteStore } from "../src/store/sqlite";
import type { Store } from "../src/store/types";
import type { TraceRow } from "../src/trace";

const migrations = readdirSync(join(import.meta.dir, "..", "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({ name: file, sql: readFileSync(join(import.meta.dir, "..", "migrations", file), "utf8") }));

const PASSPHRASE = "open-sesame-please";
const API_TOKEN = "static-token-for-scripts";
const BEARER = { authorization: `Bearer ${API_TOKEN}`, "user-agent": "curl/8.4.0" };

/** A frozen clock the tests advance by hand (PRD §3.2). */
const T0 = new Date("2026-09-07T03:00:00.000Z");
let now: Date;
const clock = () => now;
const tick = (seconds: number) => {
  now = new Date(now.getTime() + seconds * 1000);
};

let store: Store;
let app: ReturnType<typeof createApp>;

const appWith = (auth: AuthConfig, extra: { rateLimit?: boolean; embedder?: Embedder | null } = {}) =>
  createApp({ store, instanceName: "test", auth, clock, rateLimit: extra.rateLimit, embedder: extra.embedder ?? null });

const call = async (name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = BEARER, target = app) => {
  const response = await target.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const payload = (await response.json()) as any;
  const text = payload?.result?.content?.[0]?.text ?? "";
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* an error message */
  }
  return { status: response.status, isError: Boolean(payload?.result?.isError), text, data };
};

const digViaMcp = async (keyword: string, args: Record<string, unknown> = {}, headers = BEARER) => call("dig", { keyword, ...args }, headers);

const postDig = (body: Record<string, unknown>, headers: Record<string, string> = BEARER, target = app) =>
  target.fetch(
    new Request("http://localhost/api/dig", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

const traces = () => store.all<TraceRow>("SELECT * FROM traces ORDER BY rowid");
const digRows = () =>
  store.all<{ dig_seq: number; keyword: string; keyword_norm: string; method: string; principal: string; friction: number; confidence: string; counts: string; top: string }>(
    "SELECT * FROM digs ORDER BY dig_seq",
  );

/** Two nodes wearing tags:mcp — one a text hit, one reachable only through the tag — plus a category. */
const seed = async () => {
  await call("vocabulary_create", { name: "topics", kind: "categories" });
  await call("term_create", { vocabulary: "topics", name: "infra" });
  const a = (await call("node_create", { title: "MCP gateway notes", body: "the mcp gateway", terms: ["tags:mcp", "topics:infra"] })).data;
  const b = (await call("node_create", { title: "Taxonomy design", body: "vocabulary shapes", terms: ["tags:mcp"] })).data;
  const c = (await call("node_create", { title: "Solar panels", body: "roof survey", terms: ["tags:energy"] })).data;
  const terms = (await call("term_list")).data.terms as Array<{ id: string; name: string; vocabulary: string }>;
  const mcp = terms.find((t) => t.name === "mcp" && t.vocabulary === "tags")!;
  const infra = terms.find((t) => t.name === "infra")!;
  expect((await digRows()).length).toBe(0);
  return { a, b, c, mcp, infra };
};

beforeEach(async () => {
  now = new Date(T0);
  store = await openSqliteStore(":memory:", migrations);
  app = appWith({ apiToken: API_TOKEN });
});

describe("dig (PRD §3.6)", () => {
  test("an exact term name scores 100, a substring 25, and the dig leaves one digs row + one trace of kind dig", async () => {
    const { mcp } = await seed();
    await call("node_create", { title: "Old notes", body: "nothing", terms: ["tags:mcp-gateway"] });
    const { isError, data } = await digViaMcp("MCP");
    expect(isError).toBe(false);
    expect(data.keyword).toBe("MCP");
    expect(data.keyword_norm).toBe("mcp");
    expect(data.dig_seq).toBe(1);
    // Exact first, substring after, and each says why.
    expect(data.terms.map((t: any) => [t.name, t.score])).toEqual([["mcp", SCORE.termExact], ["mcp-gateway", SCORE.termLike]]);
    expect(data.items[0]).toMatchObject({ source: "term", id: mcp.id, label: "tags:mcp", score: 100, why: "exact term name" });
    expect(data.items.find((i: any) => i.label === "tags:mcp-gateway")).toMatchObject({ score: 25, why: "term name contains the keyword" });
    expect(data.counts.terms).toBe(2);
    // The write it promised: the ledger row and the trace, same dig_seq.
    const rows = await digRows();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ dig_seq: 1, keyword: "MCP", keyword_norm: "mcp", method: "api-token", principal: "curl", confidence: "high" });
    const trace = (await traces()).filter((t) => t.kind === "dig");
    expect(trace.length).toBe(1);
    expect(trace[0]).toMatchObject({ kind: "dig", surface: "mcp", subject: "keyword", subject_key: "mcp", keyword: "MCP", dig_seq: 1, hits: data.items.length });
    // The dig's own sub-queries are untraced: no `search` row appeared.
    expect((await traces()).filter((t) => t.kind === "search").length).toBe(0);
  });

  test("graph reach: a node tagged with the exact term but not a text hit scores 20, via the term", async () => {
    const { a, b, mcp } = await seed();
    const { data } = await digViaMcp("mcp");
    expect(data.nodes_fts.map((n: any) => [n.id, n.score])).toEqual([[a.id, SCORE.nodeTitle]]);
    expect(data.nodes_graph.map((n: any) => [n.id, n.score, n.via])).toEqual([[b.id, SCORE.nodeGraph, [mcp.id]]]);
    expect(data.counts).toMatchObject({ nodes_fts: 1, nodes_graph: 1 });
    const graphItem = data.items.find((i: any) => i.source === "node_graph");
    expect(graphItem).toMatchObject({ id: b.id, label: "Taxonomy design", score: 20, why: "tagged with the exact term, not a text hit" });
    // A text hit is never repeated as a graph hit.
    expect(data.nodes_graph.some((n: any) => n.id === a.id)).toBe(false);
    // Body-only hits score 15 — on the floor, still confident.
    await call("node_create", { title: "Plain title", body: "mentions mcp in the body only" });
    const again = (await digViaMcp("mcp")).data;
    expect(again.nodes_fts.find((n: any) => n.title === "Plain title").score).toBe(SCORE.nodeBody);
    expect(again.items.some((i: any) => i.label === "Plain title" && i.score === CONFIDENT_FLOOR)).toBe(true);
  });

  test("a prior dig of the same keyword scores 12 and carries its dig_seq and top — 'we have been here'", async () => {
    await seed();
    const first = (await digViaMcp("mcp")).data;
    expect(first.prior_digs).toEqual([]);
    expect(first.counts.prior_digs).toBe(0);
    tick(30);
    const second = (await digViaMcp("mcp")).data;
    expect(second.dig_seq).toBe(2);
    expect(second.counts.prior_digs).toBe(1);
    expect(second.prior_digs[0]).toMatchObject({ dig_seq: 1, at: T0.toISOString(), friction: first.friction, confidence: first.confidence });
    expect(second.prior_digs[0].top).toEqual(first.items.slice(0, 5).map((i: any) => ({ source: i.source, id: i.id, score: i.score })));
    const prior = second.weak.find((i: any) => i.source === "prior_dig");
    expect(prior).toMatchObject({ id: "1", label: "dig #1", score: SCORE.priorDig, dig_seq: 1, at: T0.toISOString() });
    // A different keyword is a different memory.
    expect((await digViaMcp("solar")).data.prior_digs).toEqual([]);
  });

  test("friction tiers: 1.0 a term names it · 0.7 only text · 0.3 asked before, never filed · 0.0 nothing; C −0.1/−0.2 by confident items", async () => {
    await seed();
    // (a) a term hit with ≥ 3 confident items → 1.0, high
    const termed = (await digViaMcp("mcp")).data;
    expect(termed.items.length).toBeGreaterThanOrEqual(3);
    expect([termed.friction, termed.confidence]).toEqual([1.0, "high"]);
    // (b) only a text hit, one confident item → 0.7 − 0.1 = 0.6, medium
    const text = (await digViaMcp("solar")).data;
    expect(text.counts).toMatchObject({ terms: 0, categories: 0, nodes_fts: 1, nodes_graph: 0 });
    expect([text.friction, text.confidence]).toEqual([0.6, "medium"]);
    // (c) only memory — a search that found nothing left a trace and a call → 0.3 − 0.2 = 0.1, low
    await call("node_search", { query: "orbit" });
    const asked = (await digViaMcp("orbit")).data;
    expect(asked.counts).toMatchObject({ terms: 0, nodes_fts: 0, nodes_graph: 0, traces: 1 });
    expect(asked.counts.calls).toBeGreaterThanOrEqual(1);
    expect(asked.items).toEqual([]);
    expect(asked.weak.length).toBeGreaterThanOrEqual(2);
    expect([asked.friction, asked.confidence]).toEqual([0.1, "low"]);
    // (d) nothing at all → 0.0, low
    const nothing = (await digViaMcp("zebra")).data;
    expect(nothing.counts).toEqual({ terms: 0, categories: 0, nodes_fts: 0, nodes_graph: 0, nodes_vector: null, traces: 0, calls: 0, related: 0, prior_digs: 0 });
    expect([nothing.friction, nothing.confidence]).toEqual([0, "low"]);
    // The function itself, on the boundary cases the doors do not reach.
    const empty = { terms: 0, categories: 0, nodes_fts: 0, nodes_graph: 0, nodes_vector: null, traces: 0, calls: 0, related: 0, prior_digs: 0 };
    expect(friction({ ...empty, categories: 1 }, 1)).toEqual({ friction: 0.9, confidence: "medium" });
    expect(friction({ ...empty, nodes_vector: 2 }, 2)).toEqual({ friction: 0.6, confidence: "medium" });
    expect(friction({ ...empty, prior_digs: 4 }, 0)).toEqual({ friction: 0.1, confidence: "low" });
    expect(friction({ ...empty, terms: 1 }, 0)).toEqual({ friction: 0.8, confidence: "low" });
  });

  test("dig_seq is monotonic and unique over 100 digs, from both doors, and every trace carries its own", async () => {
    app = appWith({ apiToken: API_TOKEN }, { rateLimit: false });
    await seed();
    const seqs: number[] = [];
    for (let i = 0; i < 100; i++) {
      const keyword = i % 3 === 0 ? "mcp" : i % 3 === 1 ? "solar" : `kw-${i}`;
      if (i % 2 === 0) {
        const { data } = await digViaMcp(keyword);
        seqs.push(data.dig_seq);
      } else {
        const response = await postDig({ q: keyword });
        expect(response.status).toBe(200);
        seqs.push(((await response.json()) as any).dig_seq);
      }
    }
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect((await store.first<{ n: number }>("SELECT COUNT(DISTINCT dig_seq) AS n FROM digs"))!.n).toBe(100);
    const digTraces = (await traces()).filter((t) => t.kind === "dig");
    expect(digTraces.map((t) => t.dig_seq)).toEqual(seqs);
    // Never caller input: a dig_seq in the arguments is ignored.
    const forged = (await call("dig", { keyword: "mcp", dig_seq: 5 })).data;
    expect(forged.dig_seq).toBe(101);
  });

  test("`top` has at most 5 items, {source, id, score}, and survives on the digs row", async () => {
    await seed();
    for (let i = 0; i < 8; i++) await call("node_create", { title: `mcp memo ${i}`, body: "an mcp memo", terms: ["tags:mcp"] });
    const { data } = await digViaMcp("mcp", { limit_per_source: 20 });
    expect(data.items.length).toBeGreaterThan(5);
    const row = (await digRows())[0]!;
    const top = JSON.parse(row.top) as Array<{ source: string; id: string; score: number }>;
    expect(top.length).toBe(5);
    expect(top).toEqual(data.items.slice(0, 5).map((i: any) => ({ source: i.source, id: i.id, score: i.score })));
    for (const item of top) expect(Object.keys(item).sort()).toEqual(["id", "score", "source"]);
    // Scores never rise down the list.
    for (let i = 1; i < data.items.length; i++) expect(data.items[i].score).toBeLessThanOrEqual(data.items[i - 1].score);
    // The same `top` comes back through /api/digs.
    const listed = (await (await app.fetch(new Request("http://localhost/api/digs", { headers: BEARER }))).json()) as any;
    expect(listed.digs[0].top).toEqual(top);
    expect(listed.digs[0].dig_seq).toBe(1);
  });

  test("as_of is the app clock and dug_by is the caller's method:principal — the frozen fixture, pinned", async () => {
    const { a, b, mcp, infra } = await seed();
    await call("node_search", { query: "mcp" });
    tick(60);
    const { data } = await digViaMcp("mcp");
    expect(data.as_of).toBe(new Date(T0.getTime() + 60_000).toISOString());
    expect(data.dug_by).toBe("api-token:curl");
    // The bundle's shape (PRD §3.6), every key present, in one snapshot.
    expect(Object.keys(data).sort()).toEqual(
      ["as_of", "calls", "categories", "confidence", "counts", "dig_seq", "dug_by", "friction", "include", "items", "keyword", "keyword_norm", "limit_per_source", "nodes_fts", "nodes_graph", "nodes_vector", "prior_digs", "related_terms", "terms", "took_ms", "traces", "weak", "window"].sort(),
    );
    expect(data.counts).toEqual({ terms: 1, categories: 0, nodes_fts: 1, nodes_graph: 1, nodes_vector: null, traces: 1, calls: 3, related: 1, prior_digs: 0 });
    expect(data.items.map((i: any) => [i.source, i.id, i.score])).toEqual([
      ["term", mcp.id, 100],
      ["node_fts", a.id, 25],
      ["node_graph", b.id, 20],
    ]);
    // Ties (same score, same frozen instant) break on label, so the order is pinned.
    expect(data.weak.map((i: any) => [i.source, i.label, i.score])).toEqual([
      ["trace", "api-token:curl", 8],
      ["call", "node_create", 5],
      ["call", "node_create", 5],
      ["call", "node_search", 5],
      ["related_term", "topics:infra", 5],
    ]);
    expect(data.traces).toEqual({
      count: 1,
      first: "2026-09-07",
      last: T0.toISOString(),
      by_kind: { search: 1 },
      principals: [{ principal: "curl", method: "api-token", ha_user: "", n: 1 }],
      days: [{ day: "2026-09-07", reads: 1, hits: 1 }],
    });
    expect(data.related_terms).toEqual([{ id: infra.id, name: "infra", vocabulary: "topics", co: 1, score: 5 }]);
    // The owner sees the calls' input; it is the raw audit log.
    // `client` is what the call log stored — the raw UA, a label, never identity.
    expect(data.calls[0]).toEqual({ tool: "node_search", at: T0.toISOString(), client: "curl/8.4.0", input: '{"query":"mcp"}' });
    expect([data.friction, data.confidence, data.window, data.limit_per_source]).toEqual([1, "high", "all", 10]);
    // And an ingress caller's dug_by names the HA user.
    const full = appWith({ apiToken: API_TOKEN, ownerPassphrase: PASSPHRASE, ingressAutoLogin: true, ingressPeer: "172.30.32.2" });
    const viaIngress = await postDig(
      { q: "mcp" },
      { "x-ingress-path": "/api/hassio_ingress/abc", "x-trace-peer-ip": "172.30.32.2", "x-remote-user-id": "alice", "x-trace-client": "ui", "user-agent": "Mozilla/5.0" },
      full,
    );
    expect(viaIngress.status).toBe(200);
    const ingressBundle = (await viaIngress.json()) as any;
    expect(ingressBundle.dug_by).toBe("ingress:172.30.32.2 (alice)");
    // Ingress sees the memory's aggregates but not the owner's principal, and never a call's input.
    expect(ingressBundle.traces.count).toBe(2);
    expect(ingressBundle.traces.principals).toEqual([]);
    expect(ingressBundle.calls.every((c: any) => !("input" in c))).toBe(true);
    expect((await traces()).at(-1)).toMatchObject({ kind: "dig", surface: "ui", method: "ingress", ha_user: "alice", dig_seq: 2 });
  });

  test("LIKE escaping: `%`, `_` and `\\` in the keyword mean themselves in the terms and calls arms", async () => {
    expect(escapeLike("100%_a\\b")).toBe("100\\%\\_a\\\\b");
    await call("term_create", { vocabulary: "tags", name: "100%" });
    await call("term_create", { vocabulary: "tags", name: "a_b" });
    await call("term_create", { vocabulary: "tags", name: "abc" });
    await call("term_create", { vocabulary: "tags", name: "back\\slash" });
    await call("term_create", { vocabulary: "tags", name: "plain" });
    const only = { include: ["terms", "calls"] };
    const percent = (await digViaMcp("%", only)).data;
    expect(percent.terms.map((t: any) => t.name)).toEqual(["100%"]);
    expect(percent.calls.map((c: any) => c.input)).toEqual(['{"vocabulary":"tags","name":"100%"}']);
    const underscore = (await digViaMcp("_", only)).data;
    expect(underscore.terms.map((t: any) => t.name)).toEqual(["a_b"]);
    expect(underscore.calls.map((c: any) => c.input)).toEqual(['{"vocabulary":"tags","name":"a_b"}']);
    const backslash = (await digViaMcp("\\", only)).data;
    expect(backslash.terms.map((t: any) => t.name)).toEqual(["back\\slash"]);
    expect(backslash.calls.map((c: any) => c.input)).toEqual(['{"vocabulary":"tags","name":"back\\\\slash"}']);
    // An exact match on a name made of wildcards is still exact.
    expect(percent.terms[0].score).toBe(SCORE.termLike);
    expect((await digViaMcp("100%", only)).data.terms.map((t: any) => [t.name, t.score])).toEqual([["100%", SCORE.termExact]]);
  });

  test("nodes_vector is null without an embedder — never an empty list — and round(20·cosine) with one", async () => {
    await seed();
    const bare = (await digViaMcp("mcp")).data;
    expect(bare.nodes_vector).toBeNull();
    expect(bare.counts.nodes_vector).toBeNull();
    expect((await postDig({ q: "mcp", include: ["vectors"] })).status).toBe(200);
    expect(JSON.parse((await digRows())[1]!.counts).nodes_vector).toBeNull();

    // A two-axis embedder: "mcp" texts point one way, everything else the other.
    const embedder: Embedder = {
      space: "test-2d",
      dim: 2,
      async embed(texts) {
        return texts.map((t) => (/mcp/i.test(t) ? [1, 0] : /solar/i.test(t) ? [0, 1] : [Math.SQRT1_2, Math.SQRT1_2]));
      },
    };
    store = await openSqliteStore(":memory:", migrations);
    app = appWith({ apiToken: API_TOKEN }, { embedder });
    const { a, b, c } = await seed();
    const { data } = await digViaMcp("mcp");
    expect(Array.isArray(data.nodes_vector)).toBe(true);
    const byId = Object.fromEntries(data.nodes_vector.map((n: any) => [n.id, n]));
    expect(byId[a.id]).toMatchObject({ cosine: 1, score: 20 });
    expect(byId[c.id]).toMatchObject({ cosine: 0, score: 0 });
    expect(byId[b.id].score).toBe(Math.round(20 * Math.SQRT1_2));
    expect(data.counts.nodes_vector).toBe(3);
    expect(data.items.find((i: any) => i.source === "node_vector")).toMatchObject({ id: a.id, score: 20, why: "cosine 1.00" });
    expect(data.weak.some((i: any) => i.source === "node_vector" && i.id === c.id && i.score === 0)).toBe(true);
  });

  test("`include` switches every one of the nine sources off, one at a time and all at once; aliases nodes/vectors expand", async () => {
    expect(parseInclude(undefined)).toEqual([...DIG_SOURCES]);
    expect(parseInclude(["nodes", "vectors", "related_terms"])).toEqual(["nodes_fts", "nodes_graph", "nodes_vector", "related"]);
    expect(parseInclude("terms,bogus,calls")).toEqual(["terms", "calls"]);
    await seed();
    // A category spelt like the keyword, so every one of the nine has something to find.
    await call("term_create", { vocabulary: "topics", name: "mcp" });
    await call("node_search", { query: "mcp" });
    const first = (await digViaMcp("mcp")).data; // seeds prior_digs for the next ones
    expect(first.counts.prior_digs).toBe(0);
    expect(first.counts.categories).toBe(1);
    expect(first.categories[0]).toMatchObject({ name: "mcp", vocabulary: "topics", score: SCORE.termExact, path: [] });
    const zero = { terms: 0, categories: 0, nodes_fts: 0, nodes_graph: 0, nodes_vector: null, traces: 0, calls: 0, related: 0, prior_digs: 0 };
    for (const source of DIG_SOURCES) {
      const { data } = await digViaMcp("mcp", { include: [source] });
      expect(data.include).toEqual([source]);
      const others = Object.fromEntries(Object.entries(data.counts).filter(([k]) => k !== source));
      expect({ source, others }).toEqual({ source, others: Object.fromEntries(Object.entries(zero).filter(([k]) => k !== source)) });
      if (source !== "nodes_vector") expect({ source, count: data.counts[source] }).not.toEqual({ source, count: 0 });
    }
    const none = (await digViaMcp("mcp", { include: [] })).data;
    expect(none.include).toEqual([]);
    expect(none.counts).toEqual(zero);
    expect([none.items, none.weak, none.friction, none.confidence]).toEqual([[], [], 0, "low"]);
    // Off is off, but the dig still happened: a row and a trace.
    expect((await digRows()).at(-1)).toMatchObject({ dig_seq: none.dig_seq, keyword_norm: "mcp" });
    expect((await traces()).at(-1)).toMatchObject({ kind: "dig", dig_seq: none.dig_seq, hits: 0 });
  });

  test("GET /api/dig → 405; a cookie needs X-Trace-Client: ui (CSRF), then the dig's surface is `ui`", async () => {
    const full = appWith({ apiToken: API_TOKEN, ownerPassphrase: PASSPHRASE });
    app = full;
    await seed();
    expect((await full.fetch(new Request("http://localhost/api/dig", { headers: BEARER }))).status).toBe(405);
    expect((await full.fetch(new Request("http://localhost/api/dig"))).status).toBe(401);
    const login = await full.fetch(
      new Request("http://localhost/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ passphrase: PASSPHRASE }).toString(),
      }),
    );
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const forbidden = await postDig({ q: "mcp" }, { cookie }, full);
    expect(forbidden.status).toBe(403);
    expect((await digRows()).length).toBe(0);
    const allowed = await postDig({ q: "mcp" }, { cookie, "x-trace-client": "ui" }, full);
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as any).dug_by).toBe("owner-session:browser");
    expect((await traces()).at(-1)).toMatchObject({ kind: "dig", surface: "ui", method: "owner-session", dig_seq: 1 });
    // A Bearer through HTTP is `http`; an empty keyword is a 400, not a row.
    expect((await postDig({ q: "solar" }, BEARER, full)).status).toBe(200);
    expect((await traces()).at(-1)).toMatchObject({ kind: "dig", surface: "http" });
    expect((await postDig({ q: "   " }, BEARER, full)).status).toBe(400);
    expect((await digRows()).length).toBe(2);
    // /api/digs is never traced, and blanks who-dug for an OAuth token without traces:read.
    const before = (await traces()).length;
    const listed = (await (await full.fetch(new Request("http://localhost/api/digs?q=mcp", { headers: BEARER }))).json()) as any;
    expect(listed.count).toBe(1);
    expect(listed.digs[0]).toMatchObject({ dig_seq: 1, method: "owner-session", principal: "browser" });
    expect((await traces()).length).toBe(before);
  });

  test("the budget: 60 digs per 10 min per method:principal — the 61st is isError / 429, and ten minutes later it digs again", async () => {
    await seed();
    expect(DIG_BUDGET).toEqual({ digs: 60, windowSeconds: 600 });
    for (let i = 0; i < 60; i++) {
      tick(1);
      const { isError } = await digViaMcp("mcp", { include: ["terms"] });
      expect({ i, isError }).toEqual({ i, isError: false });
    }
    tick(1);
    const refused = await digViaMcp("mcp", { include: ["terms"] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("dig budget");
    const http = await postDig({ q: "mcp" });
    expect(http.status).toBe(429);
    expect(Number(http.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await http.json()) as any).error).toBe("too_many_digs");
    expect((await digRows()).length).toBe(60);
    // Another principal has its own budget (a different UA family is a different api-token principal).
    const other = await digViaMcp("mcp", { include: ["terms"] }, { ...BEARER, "user-agent": "Codex/1.0" });
    expect(other.isError).toBe(false);
    // The window is the app clock: ten minutes on, the oldest of the sixty has left it.
    tick(600);
    const again = await digViaMcp("mcp", { include: ["terms"] });
    expect(again.isError).toBe(false);
    expect(again.data.dig_seq).toBe(62);
  });
});
