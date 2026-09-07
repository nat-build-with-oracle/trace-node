/**
 * The trace layer — what gets written, what never does (PRD §3.1, §3.2, §3.3, §3.7).
 *
 * The one rule under test: a trace is written when a read CARRIES AN INTENT —
 * a keyword, a term, a category, a node id — and never otherwise. "Untraced"
 * is a property of the endpoint, not of a header the caller sends, so the
 * test is "a page polling writes zero rows", not "a header is honoured".
 *
 * Every assertion here counts rows in `traces` and `trace_days` directly —
 * exactly its rows, not at least — because a write point that fires twice is
 * as wrong as one that never fires.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createApp } from "../src/app";
import type { AuthConfig, Caller } from "../src/auth";
import { traceVisibility } from "../src/cloud";
import * as db from "../src/db";
import { seesPrincipals } from "../src/mcp";
import { openSqliteStore } from "../src/store/sqlite";
import type { Store } from "../src/store/types";
import { keywordNorm, recordTrace, type TraceRow } from "../src/trace";
import { sha256Base64Url } from "../src/utils";

const migrations = readdirSync(join(import.meta.dir, "..", "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({ name: file, sql: readFileSync(join(import.meta.dir, "..", "migrations", file), "utf8") }));

const PASSPHRASE = "open-sesame-please";
const API_TOKEN = "static-token-for-scripts";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const UA = "curl/8.4.0";
const BEARER = { authorization: `Bearer ${API_TOKEN}`, "user-agent": UA };

/** A frozen clock the tests advance by hand (PRD §3.2: one clock). */
const T0 = new Date("2026-09-07T03:00:00.000Z");
let now: Date;
const clock = () => now;

let store: Store;
let app: ReturnType<typeof createApp>;

const appWith = (auth: AuthConfig, extra: { clock?: () => Date } = {}) =>
  createApp({ store, instanceName: "test", auth, clock: extra.clock ?? clock });

/** An MCP tools/call with the static token. */
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
    /* an error message, not JSON */
  }
  return { status: response.status, isError: Boolean(payload?.result?.isError), text, data };
};

const get = (path: string, headers: Record<string, string> = BEARER, target = app) =>
  target.fetch(new Request(`http://localhost${path}`, { headers }));

const json = async (path: string, headers: Record<string, string> = BEARER, target = app) =>
  (await (await get(path, headers, target)).json()) as any;

const traces = () => store.all<TraceRow>("SELECT * FROM traces ORDER BY rowid");
const days = () =>
  store.all<{ subject: string; subject_key: string; day: string; reads: number; hits: number; took_ms: number; last_at: string; label: string }>(
    "SELECT * FROM trace_days ORDER BY day, subject, subject_key",
  );

const formTo = (path: string, fields: Record<string, string>) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

const loginCookie = async (target: ReturnType<typeof createApp>) => {
  const login = await target.fetch(formTo("/login", { passphrase: PASSPHRASE }));
  return (login.headers.get("set-cookie") ?? "").split(";")[0]!;
};

/** The OAuth dance, as auth.test.ts drives it; `tracesRead` ticks the consent checkbox. */
const oauthToken = async (target: ReturnType<typeof createApp>, tracesRead = false) => {
  const registered = await target.fetch(
    new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
    }),
  );
  const client = (await registered.json()) as any;
  const verifier = "a-verifier-long-enough-to-be-real-43-chars-min";
  const approved = await target.fetch(
    formTo("/authorize", {
      passphrase: PASSPHRASE,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      state: "xyz",
      code_challenge: await sha256Base64Url(verifier),
      code_challenge_method: "S256",
      scope: "nodes:read nodes:write",
      resource: "http://localhost/mcp",
      ...(tracesRead ? { traces_read: "1" } : {}),
    }),
  );
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const token = await target.fetch(
    formTo("/oauth/token", { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier }),
  );
  return { clientId: client.client_id as string, accessToken: ((await token.json()) as any).access_token as string };
};

/** Two tagged nodes, one free tag, one controlled category. */
const seed = async () => {
  await call("vocabulary_create", { name: "topics", kind: "categories" });
  await call("term_create", { vocabulary: "topics", name: "infra" });
  const a = (await call("node_create", { title: "MCP gateway notes", body: "the mcp gateway", terms: ["tags:mcp", "topics:infra"] })).data;
  const b = (await call("node_create", { title: "Taxonomy design", body: "vocabulary shapes", terms: ["tags:mcp"] })).data;
  const terms = (await call("term_list")).data.terms as Array<{ id: string; name: string; vocabulary: string }>;
  const mcp = terms.find((t) => t.name === "mcp" && t.vocabulary === "tags")!;
  const infra = terms.find((t) => t.name === "infra" && t.vocabulary === "topics")!;
  // Seeding wrote nothing: creates and term_list carry no intent.
  expect((await traces()).length).toBe(0);
  return { a, b, mcp, infra };
};

beforeEach(async () => {
  now = new Date(T0);
  store = await openSqliteStore(":memory:", migrations);
  app = appWith({ apiToken: API_TOKEN });
});

// ── the write points (PRD §3.1) ──────────────────────────────────────────────

describe("trace — write points leave exactly their rows", () => {
  test("node_search writes one `search` row: keyword, keyword_norm, hits, mode, method:principal, client", async () => {
    await seed();
    const { data } = await call("node_search", { query: "MCP gateway" });
    expect(data.count).toBe(1);

    const rows = await traces();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      kind: "search",
      surface: "mcp",
      subject: "keyword",
      subject_key: "mcp gateway",
      keyword: "MCP gateway",
      keyword_norm: "mcp gateway",
      hits: 1,
      mode: "fts",
      method: "api-token",
      principal: "curl",
      ha_user: "",
      client: "curl",
      node_id: null,
      term_id: null,
      dig_seq: null,
    });
    expect(row.at).toBe(T0.toISOString());
    expect(row.took_ms).toBeGreaterThanOrEqual(0);
  });

  test("GET /api/nodes?q= writes one row — surface `http` for a Bearer, `ui` for a cookie", async () => {
    const both = appWith({ apiToken: API_TOKEN, ownerPassphrase: PASSPHRASE });
    app = both;
    await seed();
    expect((await get("/api/nodes?q=taxonomy")).status).toBe(200);
    const cookie = await loginCookie(both);
    expect((await get("/api/nodes?q=taxonomy", { cookie })).status).toBe(200);

    const rows = await traces();
    expect(rows.map((r) => [r.kind, r.surface, r.method, r.principal, r.hits])).toEqual([
      ["search", "http", "api-token", "curl", 1],
      ["search", "ui", "owner-session", "browser", 1],
    ]);
    // A short needle takes the LIKE path, and the row says so.
    await get("/api/nodes?q=mc");
    expect((await traces()).at(-1)!.mode).toBe("like");
  });

  test("node_get writes one `read` row — hits 1 when found, 0 when not, and the miss still errors", async () => {
    const { a } = await seed();
    expect((await call("node_get", { id: a.id })).isError).toBe(false);
    const miss = await call("node_get", { id: "node_missing" });
    expect(miss.isError).toBe(true);
    expect(miss.text).toContain("no node with id");

    const rows = await traces();
    expect(rows.map((r) => [r.kind, r.subject, r.subject_key, r.node_id, r.hits, r.surface])).toEqual([
      ["read", "node", a.id, a.id, 1, "mcp"],
      ["read", "node", "node_missing", "node_missing", 0, "mcp"],
    ]);
    expect(rows.every((r) => r.keyword === "" && r.keyword_norm === "")).toBe(true);
  });

  test("GET /api/nodes/:id writes one `read` row, and a 404 writes one with hits 0", async () => {
    const { b } = await seed();
    expect((await get(`/api/nodes/${b.id}`)).status).toBe(200);
    expect((await get("/api/nodes/node_nope")).status).toBe(404);
    const rows = await traces();
    expect(rows.map((r) => [r.kind, r.node_id, r.hits, r.surface])).toEqual([
      ["read", b.id, 1, "http"],
      ["read", "node_nope", 0, "http"],
    ]);
  });

  test("node_list with named terms writes one `term` row per term, deduplicated, hits = the result count", async () => {
    const { mcp, infra } = await seed();
    // Named twice by name and once by id: two distinct terms, two rows.
    const { data } = await call("node_list", { terms: ["tags:mcp", "tags:mcp"], term_ids: [infra.id], match: "any" });
    expect(data.count).toBe(2);

    const rows = await traces();
    expect(rows.length).toBe(2);
    const byTerm = Object.fromEntries(rows.map((r) => [r.term_id, r]));
    expect(byTerm[mcp.id]).toMatchObject({ kind: "term", subject: "term", subject_key: mcp.id, vocabulary: "tags", hits: 2, mode: "list", surface: "mcp" });
    expect(byTerm[infra.id]).toMatchObject({ kind: "category", subject: "term", subject_key: infra.id, vocabulary: "topics", hits: 2, mode: "list" });
    // An unknown name has no term to key on: nothing more is written.
    await call("node_list", { terms: ["tags:never-created"] });
    expect((await traces()).length).toBe(2);
  });

  test("GET /api/nodes?term_id= writes `term` for a free tag and `category` for a controlled vocabulary", async () => {
    const { mcp, infra } = await seed();
    expect((await json(`/api/nodes?term_id=${mcp.id}`)).count).toBe(2);
    expect((await json(`/api/nodes?term_ids=${infra.id}&match=all`)).count).toBe(1);
    const rows = await traces();
    expect(rows.map((r) => [r.kind, r.term_id, r.vocabulary, r.hits, r.surface])).toEqual([
      ["term", mcp.id, "tags", 2, "http"],
      ["category", infra.id, "topics", 1, "http"],
    ]);
  });

  test("recordTrace accepts `category` and `dig` (with dig_seq) — the kinds steps 3 and 4 will write — and folds them", async () => {
    const caller: Caller = { method: "api-token", principal: "curl", ha_user: "", client: "curl", scope: "*" };
    await recordTrace(store, { kind: "category", surface: "http", subject: "term", term_id: "term_x", vocabulary: "topics", hits: 4 }, caller, clock);
    await recordTrace(store, { kind: "dig", surface: "mcp", subject: "keyword", keyword: "MCP", hits: 9, dig_seq: 1, took_ms: 41 }, caller, clock);
    const rows = await traces();
    expect(rows.map((r) => [r.kind, r.subject, r.subject_key, r.dig_seq, r.hits])).toEqual([
      ["category", "term", "term_x", null, 4],
      ["dig", "keyword", "mcp", 1, 9],
    ]);
    expect((await days()).map((d) => [d.subject, d.subject_key, d.reads, d.hits, d.took_ms, d.label])).toEqual([
      ["keyword", "mcp", 1, 9, 41, "MCP"],
      ["term", "term_x", 1, 4, 0, ""],
    ]);
  });
});

// ── untraced by construction (PRD §3.1) ──────────────────────────────────────

describe("trace — untraced by construction", () => {
  test("a page polling its endpoints writes zero rows", async () => {
    await seed();
    // Everything page.html fetches on load and on refresh (page.html j() calls),
    // plus the trace layer's own reads (PRD §3.1: untraced by construction).
    const polled = [
      "/api/health",
      "/api/cloud",
      "/api/cloud?window=24h&by=all",
      "/api/cloud?window=all&by=term&include_empty=1",
      "/api/terms",
      "/api/types",
      "/api/stats",
      "/api/calls?limit=25",
      "/api/calls/stats",
      "/api/nodes?untagged=1",
      "/api/timeline?limit=60",
      "/api/passphrase",
      "/api/vocabularies",
      "/api/connections?since=24h",
      "/api/clients",
      "/api/tools",
      "/api/nodes",
      "/api/nodes?type=note",
      "/api/nodes?status=1",
      "/api/traces",
      "/api/categories",
    ];
    for (const path of polled) {
      const response = await get(path);
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
    }
    expect((await traces()).length).toBe(0);
    expect((await days()).length).toBe(0);
  });

  test("a `vocabulary=`-only list writes no row — it carries no single intent", async () => {
    await seed();
    expect((await json("/api/nodes?vocabulary=tags")).count).toBe(2);
    expect((await json("/api/nodes?vocabulary=topics&match=all")).count).toBe(1);
    const { data } = await call("node_list", { vocabulary: "tags" });
    expect(data.count).toBe(2);
    expect((await traces()).length).toBe(0);
  });

  test("MCP reads with no intent — term_list, call_log, call_stats, status, lists, types — write zero rows", async () => {
    await seed();
    for (const [tool, args] of [
      ["term_list", {}],
      ["term_list", { vocabulary: "tags" }],
      ["call_log", { limit: 5 }],
      ["call_stats", {}],
      ["status", {}],
      ["vocabulary_list", {}],
      ["node_types", {}],
      ["node_list", {}],
      ["node_list", { untagged: true }],
      ["node_list", { type: "note", status: 1 }],
    ] as const) {
      const result = await call(tool, args as Record<string, unknown>);
      expect({ tool, isError: result.isError }).toEqual({ tool, isError: false });
    }
    expect((await traces()).length).toBe(0);
    // The calls themselves were logged — the audit log is not the trace log.
    expect((await store.first<{ c: number }>("SELECT COUNT(*) AS c FROM mcp_calls"))!.c).toBeGreaterThan(5);
  });
});

// ── keyword_norm (PRD §3.1) ──────────────────────────────────────────────────

describe("trace — keyword_norm", () => {
  test("collapses case, whitespace and one trailing `*`, NFC-normalises, and keeps Thai intact", async () => {
    expect(keywordNorm("  MCP   Gateway  ")).toBe("mcp gateway");
    expect(keywordNorm("mcp*")).toBe("mcp");
    expect(keywordNorm("MCP *")).toBe("mcp");
    expect(keywordNorm("a\t\n b")).toBe("a b");
    // é as e + combining acute → precomposed é.
    expect(keywordNorm("café")).toBe("café");
    expect(keywordNorm("  ทดสอบ ระบบ  ")).toBe("ทดสอบ ระบบ");
    expect(keywordNorm("ทดสอบ*")).toBe("ทดสอบ");

    await call("node_create", { title: "ทดสอบระบบ", body: "หมายเหตุ" });
    const { data } = await call("node_search", { query: "  ทดสอบ  " });
    expect(data.count).toBe(1);
    await get("/api/nodes?q=MCP*");
    const rows = await traces();
    expect(rows.map((r) => [r.keyword, r.keyword_norm, r.subject_key])).toEqual([
      ["  ทดสอบ  ", "ทดสอบ", "ทดสอบ"],
      ["MCP*", "mcp", "mcp"],
    ]);
  });

  test("a keyword that is empty after normalisation writes no row", async () => {
    await seed();
    for (const q of ["*", "   ", " * "]) {
      expect((await call("node_search", { query: q })).isError).toBe(false);
      expect((await get(`/api/nodes?q=${encodeURIComponent(q)}`)).status).toBe(200);
    }
    expect((await traces()).length).toBe(0);
    expect((await days()).length).toBe(0);
  });

  test("keyword is clipped to 200 and client to 120 at write, never refused by the CHECKs", async () => {
    const long = "x".repeat(300);
    const ua = "LongAgent/1.0 " + "y".repeat(300);
    const { data } = await call("node_search", { query: long }, { authorization: `Bearer ${API_TOKEN}`, "user-agent": ua });
    expect(data.mode).toBe("fts");
    const rows = await traces();
    expect(rows.length).toBe(1);
    expect(rows[0]!.keyword.length).toBe(200);
    expect(rows[0]!.keyword_norm).toBe("x".repeat(200));
    expect(rows[0]!.client.length).toBeLessThanOrEqual(120);
    expect(rows[0]!.client).toBe("LongAgent");
  });

  test("best-effort: with the traces table gone the search still answers, and one line is logged", async () => {
    await seed();
    await store.run("DROP TABLE traces");
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      const { data, isError } = await call("node_search", { query: "taxonomy" });
      expect(isError).toBe(false);
      expect(data.count).toBe(1);
      expect((await get("/api/nodes?q=taxonomy")).status).toBe(200);
    } finally {
      console.log = original;
    }
    expect(lines.filter((l) => l.startsWith("[trace] not recorded")).length).toBe(2);
  });
});

// ── trace_days (PRD §3.2) ────────────────────────────────────────────────────

describe("trace — trace_days folds", () => {
  test("three same-day reads of one keyword → one bucket: reads 3, hits and took_ms summed, last spelling kept", async () => {
    await seed();
    for (const q of ["MCP", " mcp ", "Mcp*"]) {
      now = new Date(now.getTime() + 60_000);
      await call("node_search", { query: q });
    }
    const rows = await traces();
    expect(rows.length).toBe(3);
    const buckets = await days();
    expect(buckets.length).toBe(1);
    // "MCP" and " mcp " each hit the gateway note; the quoted phrase "Mcp*"
    // matches nothing — three reads, and the bucket sums what each one saw.
    expect(rows.map((r) => r.hits)).toEqual([1, 1, 0]);
    expect(buckets[0]).toEqual({
      subject: "keyword",
      subject_key: "mcp",
      day: "2026-09-07",
      reads: 3,
      hits: 2,
      took_ms: rows.reduce((sum, r) => sum + r.took_ms, 0),
      last_at: now.toISOString(),
      label: "Mcp*",
    });
  });

  test("the next day opens a second bucket for the same key", async () => {
    await seed();
    await call("node_search", { query: "mcp" });
    now = new Date(T0.getTime() + 24 * 60 * 60 * 1000);
    await call("node_search", { query: "mcp" });
    await call("node_search", { query: "mcp" });
    const buckets = await days();
    expect(buckets.map((b) => [b.day, b.reads])).toEqual([
      ["2026-09-07", 1],
      ["2026-09-08", 2],
    ]);
    // Every raw row's day matches its bucket, by construction of the batch.
    for (const row of await traces()) expect(buckets.some((b) => b.day === row.at.slice(0, 10))).toBe(true);
  });

  test("evicting raw rows leaves the buckets intact", async () => {
    await seed();
    await call("node_search", { query: "mcp" });
    await call("node_search", { query: "mcp" });
    await get("/api/nodes?q=taxonomy");
    const before = await days();
    expect(before.length).toBe(2);

    // What the janitor (step 3) does to rows older than the retention window.
    const evicted = await store.run("DELETE FROM traces");
    expect(evicted.changes).toBe(3);
    expect((await traces()).length).toBe(0);
    expect(await days()).toEqual(before);
    expect((await json("/api/traces")).count).toBe(0);
  });

  test("term and node buckets carry label '' (resolved by JOIN); keyword buckets carry the last raw spelling", async () => {
    const { a, mcp } = await seed();
    await call("node_get", { id: a.id });
    await call("node_list", { term_ids: [mcp.id] });
    await call("node_search", { query: "Gateway" });
    const buckets = await days();
    expect(buckets.map((b) => [b.subject, b.subject_key, b.label])).toEqual([
      ["keyword", "gateway", "Gateway"],
      ["node", a.id, ""],
      ["term", mcp.id, ""],
    ]);
  });
});

// ── GET /api/traces (PRD §3.3, §3.10) ────────────────────────────────────────

describe("GET /api/traces", () => {
  test("rows come newest first with rowid as the tiebreaker, and kind=, since=, limit= filter", async () => {
    const { a } = await seed();
    // A frozen clock: every row shares one `at`, so only rowid can order them.
    await call("node_search", { query: "one" });
    await call("node_search", { query: "two" });
    await call("node_get", { id: a.id });
    await call("node_search", { query: "three" });

    const all = await json("/api/traces");
    expect(all.count).toBe(4);
    expect(all.traces.map((r: TraceRow) => r.keyword || r.kind)).toEqual(["three", "read", "two", "one"]);
    expect(new Set(all.traces.map((r: TraceRow) => r.at)).size).toBe(1);
    expect(all.traces[0]).toMatchObject({ method: "api-token", principal: "curl", surface: "mcp" });

    expect((await json("/api/traces?kind=read")).traces.map((r: TraceRow) => r.kind)).toEqual(["read"]);
    expect((await json("/api/traces?limit=2")).traces.map((r: TraceRow) => r.keyword || r.kind)).toEqual(["three", "read"]);
    const later = new Date(T0.getTime() + 60_000).toISOString();
    expect((await json(`/api/traces?since=${encodeURIComponent(later)}`)).count).toBe(0);
    expect((await json(`/api/traces?since=${encodeURIComponent(T0.toISOString())}`)).count).toBe(4);
  });

  test("owner-session and api-token only: an OAuth token and an ingress user get 403, a cookie 200", async () => {
    const full = appWith({ apiToken: API_TOKEN, ownerPassphrase: PASSPHRASE, ingressAutoLogin: true, ingressPeer: "172.30.32.2" });
    app = full;
    await seed();
    expect((await get("/api/traces")).status).toBe(200);
    expect((await get("/api/traces", { cookie: await loginCookie(full) })).status).toBe(200);

    const { accessToken } = await oauthToken(full, true);
    const viaOauth = await get("/api/traces", { authorization: `Bearer ${accessToken}` });
    expect(viaOauth.status).toBe(403);
    expect(((await viaOauth.json()) as any).error).toBe("forbidden");

    const viaIngress = await get("/api/traces", {
      "x-ingress-path": "/api/hassio_ingress/abc",
      "x-trace-peer-ip": "172.30.32.2",
      "x-remote-user-id": "alice",
    });
    expect(viaIngress.status).toBe(403);
    // Reading the log wrote nothing, whoever asked.
    expect((await traces()).length).toBe(0);
  });

  test("rows carry the gate's identity: oauth → principal = client_id, ingress → ha_user; mcp_calls gains method:principal", async () => {
    const full = appWith({ apiToken: API_TOKEN, ownerPassphrase: PASSPHRASE, ingressAutoLogin: true, ingressPeer: "172.30.32.2" });
    app = full;
    const { a } = await seed();

    const { clientId, accessToken } = await oauthToken(full);
    const viaOauth = await call("node_search", { query: "taxonomy" }, { authorization: `Bearer ${accessToken}`, "user-agent": "claude-ai/1.0" });
    expect(viaOauth.isError).toBe(false);

    const ingress = {
      "x-ingress-path": "/api/hassio_ingress/abc",
      "x-trace-peer-ip": "172.30.32.2",
      "x-remote-user-id": "alice",
      "user-agent": "Mozilla/5.0",
    };
    expect((await get(`/api/nodes/${a.id}`, ingress)).status).toBe(200);

    const rows = await traces();
    expect(rows.map((r) => [r.kind, r.method, r.principal, r.ha_user, r.surface])).toEqual([
      ["search", "oauth", clientId, "", "mcp"],
      ["read", "ingress", "172.30.32.2", "alice", "ui"],
    ]);

    // The audit log attributes the call too (migration 0009) — visible to the
    // owner, blanked for an OAuth token without traces:read (§3.10).
    const owner = await json("/api/calls?tool=node_search");
    expect(owner.calls[0]).toMatchObject({ tool: "node_search", method: "oauth", principal: clientId });
    const viaToken = await call("call_log", { tool: "node_search" }, { authorization: `Bearer ${accessToken}` });
    expect(viaToken.data.calls[0]).toMatchObject({ tool: "node_search", method: "", principal: "" });
  });

  test("ingress user A never sees another principal's method:principal through call_log or GET /api/calls (§3.10)", async () => {
    const full = appWith({ apiToken: API_TOKEN, ownerPassphrase: PASSPHRASE, ingressAutoLogin: true, ingressPeer: "172.30.32.2" });
    app = full;
    await seed();

    // Two other principals leave audit rows: the static token and an OAuth client.
    expect((await call("node_types")).isError).toBe(false);
    const { clientId, accessToken } = await oauthToken(full);
    expect((await call("node_search", { query: "taxonomy" }, { authorization: `Bearer ${accessToken}` })).isError).toBe(false);

    // The owner sees both identities — the rows really carry them.
    const owner = await json("/api/calls");
    expect(owner.calls.map((c: any) => [c.tool, c.method, c.principal])).toEqual(
      expect.arrayContaining([
        ["node_types", "api-token", "curl"],
        ["node_search", "oauth", clientId],
      ]),
    );

    // buildCaller stamps scope "*" on ingress; the rule must not read that as "owner".
    const ingress = {
      "x-ingress-path": "/api/hassio_ingress/abc",
      "x-trace-peer-ip": "172.30.32.2",
      "x-remote-user-id": "alice",
      "user-agent": "Mozilla/5.0",
    };
    const viaHttp = await get("/api/calls", ingress);
    expect(viaHttp.status).toBe(200);
    const httpCalls = ((await viaHttp.json()) as any).calls as Array<{ method: string; principal: string }>;
    expect(httpCalls.length).toBeGreaterThanOrEqual(2);
    for (const row of httpCalls) expect([row.method, row.principal]).toEqual(["", ""]);

    const viaMcp = await call("call_log", {}, ingress);
    expect(viaMcp.status).toBe(200);
    expect(viaMcp.isError).toBe(false);
    expect(viaMcp.data.calls.length).toBeGreaterThanOrEqual(2);
    for (const row of viaMcp.data.calls) expect([row.method, row.principal]).toEqual(["", ""]);

    // And the rule itself, pinned on the exact caller shape the gate builds.
    expect(seesPrincipals({ method: "ingress", principal: "172.30.32.2", ha_user: "alice", client: "Mozilla", scope: "*" })).toBe(false);
    expect(seesPrincipals({ method: "owner-session", principal: "10.0.0.1", ha_user: "", client: "Mozilla", scope: "*" })).toBe(true);
    expect(seesPrincipals({ method: "api-token", principal: "curl", ha_user: "", client: "curl", scope: "*" })).toBe(true);
    expect(seesPrincipals({ method: "oauth", principal: clientId, ha_user: "", client: "", scope: "nodes:read" })).toBe(false);
    expect(seesPrincipals({ method: "oauth", principal: clientId, ha_user: "", client: "", scope: "nodes:read traces:read" })).toBe(true);
  });
});

// ── the timeline arm (PRD §3.7) ──────────────────────────────────────────────

describe("timeline", () => {
  test("gains a `trace` arm: label = keyword, detail = kind, interleaved by at then rowid", async () => {
    const { a } = await seed();
    await call("node_search", { query: "MCP gateway" });
    await call("node_get", { id: a.id });

    const { events } = await json("/api/timeline?limit=20");
    const kinds = new Set(events.map((e: any) => e.kind));
    expect(kinds).toEqual(new Set(["node", "call", "trace"]));

    const traced = events.filter((e: any) => e.kind === "trace");
    expect(traced.map((e: any) => [e.label, e.detail, e.outcome])).toEqual([
      ["", "read", null],
      ["MCP gateway", "search", null],
    ]);
    expect(traced.every((e: any) => typeof e.duration_ms === "number")).toBe(true);
    // Everything shares the frozen clock, so the order is pure rowid DESC:
    // the newest write — the node_get's own call log row — comes first.
    expect(events[0].kind).toBe("call");
    expect(events[0].label).toBe("node_get");
    // Reading the timeline wrote nothing.
    expect((await traces()).length).toBe(2);
  });
});

// ── the cloud (PRD §3.5) ─────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const cloud = async (qs: string, headers: Record<string, string> = BEARER) => await json(`/api/cloud?${qs}`, headers);
const item = (c: any, label: string, kind?: string) =>
  c.items.find((i: any) => i.label === label && (kind === undefined || i.kind === kind));

/** A free tag worn by `count` nodes — usage without any read. */
const tagWorn = async (name: string, count: number, vocabulary = "tags") => {
  const term = await db.createTerm(store, { vocabulary, name });
  for (let i = 0; i < count; i++) {
    const node = await db.createNode(store, { title: `${name} ${i}` });
    await db.tagNode(store, node.id, [term.id]);
  }
  return term;
};

describe("tag cloud (PRD §3.5)", () => {
  test("fixture: with max_n = 40, n = 0 → 11.0 px, n = 1 → 12.7 px, n = 40 → 20.0 px; include_empty keeps the 11 px row", async () => {
    await tagWorn("zero", 0);
    await tagWorn("one", 1);
    await tagWorn("forty", 40);

    const c = await cloud("window=all&by=term&include_empty=1");
    expect(c).toMatchObject({ window: "all", by: "term", max_n: 40, granularity: "day" });
    expect(c.items.map((i: any) => [i.label, i.n, i.size_px.toFixed(1)])).toEqual([
      ["forty", 40, "20.0"],
      ["one", 1, "12.7"],
      ["zero", 0, "11.0"],
    ]);
    expect(item(c, "one").weight).toBeCloseTo(Math.log(2) / Math.log(41), 12);
    expect(item(c, "forty")).toMatchObject({ usage: 40, reads: 0, hits: 0, kind: "term", subject: "term", vocabulary: "tags", weight: 1 });

    // The default drops n = 0: a cloud of everything nobody touched is a list.
    const dropped = await cloud("window=all&by=term");
    expect(dropped.items.map((i: any) => i.label)).toEqual(["forty", "one"]);
    expect(dropped.max_n).toBe(40);

    // The tool is the same function: byte-equal items.
    const { data, isError } = await call("tag_cloud", { window: "all", by: "term", include_empty: true });
    expect(isError).toBe(false);
    expect(data.items).toEqual(c.items);
    // And the cloud read wrote nothing.
    expect((await traces()).length).toBe(0);
  });

  test("frozen clock: a read 7 days old counts 0.5 in `7d`, is outside `24h`, and is 1 in `all`", async () => {
    await seed();
    await call("node_search", { query: "mcp gateway" });
    const key = "mcp gateway";

    expect(item(await cloud("window=all&by=keyword"), key)).toMatchObject({ reads: 1, n: 1, usage: 0 });

    now = new Date(T0.getTime() + 7 * DAY);
    const week = await cloud("window=7d&by=keyword");
    expect(item(week, key)).toMatchObject({ reads: 0.5, n: 0.5, hits: 1 });
    expect(week.max_n).toBe(0.5);
    expect((await cloud("window=24h&by=keyword")).items).toEqual([]);
    expect(item(await cloud("window=all&by=keyword"), key).reads).toBe(1);

    // One day old: yesterday's bucket × 0.5 in 24h, × 0.5^(1/7) in 7d.
    now = new Date(T0.getTime() + 1 * DAY);
    expect(item(await cloud("window=24h&by=keyword"), key).reads).toBe(0.5);
    expect(item(await cloud("window=7d&by=keyword"), key).reads).toBeCloseTo(Math.pow(0.5, 1 / 7), 12);
  });

  test("`24h` and `all` differ by the decay: two reads yesterday + one today = 2 in 24h, 3 in all", async () => {
    await seed();
    await call("node_search", { query: "taxonomy" });
    await call("node_search", { query: "taxonomy" });
    now = new Date(T0.getTime() + DAY);
    await call("node_search", { query: "Taxonomy" });

    const day = await cloud("window=24h&by=keyword");
    const week = await cloud("window=7d&by=keyword");
    const all = await cloud("window=all&by=keyword");
    expect(item(day, "Taxonomy").reads).toBe(2);
    expect(item(week, "Taxonomy").reads).toBeCloseTo(2 * Math.pow(0.5, 1 / 7) + 1, 12);
    expect(item(all, "Taxonomy")).toMatchObject({ reads: 3, hits: 3, key: "taxonomy", kind: "keyword" });
    // Day buckets, and the response says so.
    for (const c of [day, week, all]) expect(c.granularity).toBe("day");
    // The label is the latest spelling; the key is the normalised one.
    expect(item(all, "Taxonomy").label).toBe("Taxonomy");
    expect((await days()).map((d) => [d.day, d.reads, d.label])).toEqual([
      ["2026-09-07", 2, "taxonomy"],
      ["2026-09-08", 1, "Taxonomy"],
    ]);
  });

  test("`by=all` shares one max_n across terms, categories and keywords; sorted weight DESC, last DESC, label ASC; limit clamps", async () => {
    await call("vocabulary_create", { name: "topics", kind: "categories" });
    await call("term_create", { vocabulary: "topics", name: "untouched" });
    await tagWorn("three", 3);
    await call("node_search", { query: "zeta" });
    await call("node_search", { query: "alpha" });

    const alone = await cloud("window=all&by=keyword");
    expect(alone.max_n).toBe(1);
    expect(alone.items.map((i: any) => [i.label, i.weight])).toEqual([
      ["alpha", 1],
      ["zeta", 1],
    ]);

    const all = await cloud("window=all&by=all");
    expect(all.max_n).toBe(3);
    // The same keyword weighs less once a heavier term shares the scale.
    expect(item(all, "zeta").weight).toBeCloseTo(Math.log(2) / Math.log(4), 12);
    expect(all.items.map((i: any) => [i.label, i.kind])).toEqual([
      ["three", "term"],
      ["alpha", "keyword"],
      ["zeta", "keyword"],
    ]);
    // include_empty brings the untouched category in at 11 px, last.
    const withEmpty = await cloud("window=all&by=all&include_empty=1");
    expect(withEmpty.items.at(-1)).toMatchObject({ label: "untouched", kind: "category", n: 0, size_px: 11 });
    expect((await cloud("window=all&by=all&limit=1")).items.length).toBe(1);
    // Out-of-range limits clamp into 1-500 (default 100), never error.
    expect((await cloud("window=all&by=all&limit=0")).items.length).toBe(1);
    expect((await cloud("window=all&by=all&limit=9999")).items.length).toBe(3);
    expect((await cloud("window=all&by=all&limit=abc")).items.length).toBe(3);
  });

  test("`by=category` rolls descendants' reads up to the parent, and GET /api/categories/:id agrees", async () => {
    await call("vocabulary_create", { name: "topics", kind: "categories" });
    const infra = (await call("term_create", { vocabulary: "topics", name: "infra" })).data;
    const network = (await call("term_create", { vocabulary: "topics", name: "network", parent_id: infra.id })).data;
    const wifi = (await call("term_create", { vocabulary: "topics", name: "wifi", parent_id: network.id })).data;
    const node = (await call("node_create", { title: "AP placement", terms: ["topics:wifi"] })).data;
    expect((await call("node_list", { term_ids: [wifi.id] })).data.count).toBe(1);

    const c = await cloud("window=all&by=category&include_empty=1");
    expect(c.items.map((i: any) => [i.label, i.usage, i.reads, i.n])).toEqual([
      ["wifi", 1, 1, 2],
      ["infra", 0, 1, 1],
      ["network", 0, 1, 1],
    ]);
    expect(c.max_n).toBe(2);

    const parent = await json(`/api/categories/${infra.id}`);
    expect(parent).toMatchObject({ vocabulary: "topics", kind: "categories", path: [], usage: 0, reads_24h: 1, reads_7d: 1, reads_all: 1 });
    expect(parent.children.map((k: any) => [k.name, k.usage, k.reads])).toEqual([["network", 0, 1]]);
    expect(parent.nodes).toEqual([]);
    const leaf = await json(`/api/categories/${wifi.id}`);
    expect(leaf.path.map((p: any) => p.name)).toEqual(["infra", "network"]);
    expect(leaf.nodes.map((n: any) => n.id)).toEqual([node.id]);
    expect(leaf.usage).toBe(1);
  });

  test("search \"MCP\" counts as a read of term \"mcp\" — and search \"mcp\" of a term named \"MCP\"", async () => {
    const { mcp } = await seed(); // tags:mcp, worn by two nodes
    await call("term_create", { vocabulary: "labels", name: "MCP" });
    await call("node_search", { query: "MCP" });
    await call("node_search", { query: "mcp" });
    await call("node_search", { query: " Mcp " });

    const c = await cloud("window=all&by=term");
    expect(item(c, "mcp", "term")).toMatchObject({ id: mcp.id, vocabulary: "tags", usage: 2, reads: 3, n: 5 });
    expect(item(c, "MCP", "term")).toMatchObject({ vocabulary: "labels", usage: 0, reads: 3, n: 3 });
    // The raw keyword is its own item too, under the latest (trimmed) spelling.
    expect(item(await cloud("window=all&by=keyword"), "Mcp")).toMatchObject({ key: "mcp", reads: 3 });
    // And /api/trace?term= sees the alias the same way.
    expect((await json(`/api/trace?term=${mcp.id}`)).count).toBe(0); // term buckets only: nobody listed BY the term
    expect((await json("/api/trace?q=MCP")).count).toBe(3);
  });

  test("trace + GET /api/trace: one subject exactly; totals and days survive eviction; by_kind, by_method, principals, rows newest first; never traced", async () => {
    const { a, mcp } = await seed();
    await call("node_search", { query: "mcp" });
    now = new Date(T0.getTime() + 60_000);
    await get("/api/nodes?q=MCP");
    await call("node_get", { id: a.id });
    await call("node_list", { term_ids: [mcp.id] });
    const written = (await traces()).length;
    expect(written).toBe(4);

    const kw = await json("/api/trace?q=Mcp");
    expect(kw).toMatchObject({
      subject: "keyword",
      key: "mcp",
      label: "MCP",
      window: "all",
      granularity: "day",
      count: 2,
      first: "2026-09-07",
      last: now.toISOString(),
      by_kind: { search: 2 },
      by_method: { "api-token": 2 },
      principals: [{ principal: "curl", method: "api-token", ha_user: "", n: 2 }],
      days: [{ day: "2026-09-07", reads: 2, hits: 2 }],
    });
    expect(kw.rows.map((r: any) => [r.surface, r.at])).toEqual([
      ["http", now.toISOString()],
      ["mcp", T0.toISOString()],
    ]);
    expect(Object.keys(kw.rows[0]).sort()).toEqual(
      ["at", "client", "dig_seq", "ha_user", "hits", "kind", "method", "mode", "node_id", "principal", "surface", "term_id", "took_ms"],
    );

    const viaTool = await call("trace", { keyword: "MCP" });
    expect(viaTool.isError).toBe(false);
    expect(viaTool.data).toEqual(kw);
    expect((await call("trace", { term_id: mcp.id })).data).toMatchObject({ subject: "term", key: mcp.id, label: "mcp", count: 1, by_kind: { term: 1 } });
    expect(await json(`/api/trace?node=${a.id}`)).toMatchObject({ subject: "node", label: a.title, count: 1, by_kind: { read: 1 } });
    expect((await json("/api/trace?q=mcp&limit=1")).rows.length).toBe(1);
    expect((await json(`/api/trace?q=mcp&since=${encodeURIComponent(now.toISOString())}`)).rows.length).toBe(1);

    // Exactly one subject, or nothing.
    expect((await get("/api/trace")).status).toBe(400);
    expect((await get(`/api/trace?q=mcp&node=${a.id}`)).status).toBe(400);
    expect((await call("trace", {})).isError).toBe(true);
    expect((await call("trace", { keyword: "*" })).isError).toBe(true);

    // Eviction takes the rows, not the memory.
    await store.run("DELETE FROM traces");
    const after = await json("/api/trace?q=mcp");
    expect(after).toMatchObject({ count: 2, days: kw.days, by_kind: {}, principals: [], rows: [] });

    // None of the reads above wrote a row: the log was read, not added to.
    await store.run("DELETE FROM traces");
    await call("node_search", { query: "mcp" });
    for (const path of ["/api/trace?q=mcp", `/api/trace?term=${mcp.id}`, "/api/cloud", "/api/cloud?by=keyword&window=24h"]) {
      expect((await get(path)).status).toBe(200);
    }
    await call("trace", { keyword: "mcp" });
    await call("tag_cloud", {});
    expect((await traces()).length).toBe(1);
  });

  test("category browse writes one `category` row with hits = the nodes filed there — HTTP and MCP alike; unknown ids write nothing", async () => {
    const { infra, mcp } = await seed();
    expect((await get(`/api/categories/${infra.id}`)).status).toBe(200);
    const viaTool = await call("category", { vocabulary: "topics", name: "infra" });
    expect(viaTool.isError).toBe(false);
    expect(viaTool.data).toMatchObject({ vocabulary: "topics", kind: "categories", usage: 1 });
    // A free tag through the same door is a `term` read — one rule (§3.1).
    expect((await call("category", { id: mcp.id })).data).toMatchObject({ vocabulary: "tags", kind: "tags", usage: 2 });

    const rows = await traces();
    expect(rows.map((r) => [r.kind, r.term_id, r.vocabulary, r.hits, r.surface, r.mode])).toEqual([
      ["category", infra.id, "topics", 1, "http", ""],
      ["category", infra.id, "topics", 1, "mcp", ""],
      ["term", mcp.id, "tags", 2, "mcp", ""],
    ]);
    const buckets = (await days()).map((d) => [d.subject, d.subject_key, d.reads, d.hits]);
    expect(buckets.length).toBe(2);
    expect(buckets).toEqual(expect.arrayContaining([["term", infra.id, 2, 2], ["term", mcp.id, 1, 2]]));

    expect((await get("/api/categories/term_nope")).status).toBe(404);
    expect((await call("category", { id: "term_nope" })).isError).toBe(true);
    expect((await call("category", { vocabulary: "topics", name: "nope" })).isError).toBe(true);
    expect((await call("category", {})).isError).toBe(true);
    expect((await traces()).length).toBe(3);
  });
});

// ── visibility (PRD §3.10) ───────────────────────────────────────────────────

describe("visibility (PRD §3.10)", () => {
  const ingressAs = (user: string) => ({
    "x-ingress-path": "/api/hassio_ingress/abc",
    "x-trace-peer-ip": "172.30.32.2",
    "x-remote-user-id": user,
    "user-agent": "Mozilla/5.0",
  });

  test("an OAuth token without traces:read calling trace → isError, zero rows; with it → rows and principals, ha_user blanked; the cloud works either way", async () => {
    const full = appWith({ apiToken: API_TOKEN, ownerPassphrase: PASSPHRASE, ingressAutoLogin: true, ingressPeer: "172.30.32.2" });
    app = full;
    const { a } = await seed();
    expect((await get(`/api/nodes/${a.id}`, ingressAs("alice"))).status).toBe(200);
    await call("node_search", { query: "mcp" });

    const bare = await oauthToken(full);
    const refused = await call("trace", { node_id: a.id }, { authorization: `Bearer ${bare.accessToken}` });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("traces:read");
    expect(refused.data).toBeNull();
    const viaHttp = await get(`/api/trace?node=${a.id}`, { authorization: `Bearer ${bare.accessToken}` });
    expect(viaHttp.status).toBe(403);
    expect(((await viaHttp.json()) as any).error).toBe("forbidden");
    // Aggregates are not the log: the cloud still answers.
    const cloudBare = await call("tag_cloud", { window: "all" }, { authorization: `Bearer ${bare.accessToken}` });
    expect(cloudBare.isError).toBe(false);
    expect(cloudBare.data.items.length).toBeGreaterThan(0);

    const scoped = await oauthToken(full, true);
    const seen = await call("trace", { node_id: a.id }, { authorization: `Bearer ${scoped.accessToken}` });
    expect(seen.isError).toBe(false);
    expect(seen.data.count).toBe(1);
    expect(seen.data.rows.map((r: any) => [r.method, r.principal, r.ha_user])).toEqual([["ingress", "172.30.32.2", ""]]);
    expect(seen.data.principals).toEqual([{ principal: "172.30.32.2", method: "ingress", n: 1 }]);
    // The owner sees the person behind the row.
    const owner = await json(`/api/trace?node=${a.id}`);
    expect(owner.rows[0].ha_user).toBe("alice");
    expect(owner.principals[0].ha_user).toBe("alice");

    expect(traceVisibility({ method: "oauth", principal: bare.clientId, ha_user: "", client: "", scope: "nodes:read nodes:write" })).toBe("none");
    expect(traceVisibility({ method: "oauth", principal: scoped.clientId, ha_user: "", client: "", scope: "nodes:read nodes:write traces:read" })).toBe("scoped");
    expect(traceVisibility({ method: "ingress", principal: "172.30.32.2", ha_user: "alice", client: "Mozilla", scope: "*" })).toBe("own");
    expect(traceVisibility({ method: "api-token", principal: "curl", ha_user: "", client: "curl", scope: "*" })).toBe("all");
    // Reading never wrote: two intents, two rows.
    expect((await traces()).length).toBe(2);

    // The same rule on the dig (§3.6 `calls`, §3.10): the `node_search` above
    // left an mcp_calls row whose input mentions "mcp". Without traces:read the
    // dig still answers — terms and nodes — but carries no call rows, no `call`
    // items, and no principals; with the scope, `{tool, at, client}` and never
    // `input`; the owner sees the input itself.
    const digBare = await call("dig", { keyword: "mcp" }, { authorization: `Bearer ${bare.accessToken}` });
    expect(digBare.isError).toBe(false);
    expect(digBare.data.terms.length).toBeGreaterThan(0);
    expect(digBare.data.nodes_fts.length).toBeGreaterThan(0);
    expect(digBare.data.calls).toEqual([]);
    expect(digBare.data.counts.calls).toBe(0);
    expect(digBare.data.traces.principals).toEqual([]);
    expect([...digBare.data.items, ...digBare.data.weak].filter((i: any) => i.source === "call")).toEqual([]);
    expect(JSON.stringify(digBare.data)).not.toContain("curl/8.4.0");

    const digScoped = await call("dig", { keyword: "mcp" }, { authorization: `Bearer ${scoped.accessToken}` });
    expect(digScoped.isError).toBe(false);
    expect(digScoped.data.calls.length).toBeGreaterThan(0);
    expect(digScoped.data.counts.calls).toBe(digScoped.data.calls.length);
    expect(digScoped.data.calls.map((c: any) => Object.keys(c).sort())).toEqual(digScoped.data.calls.map(() => ["at", "client", "tool"]));
    expect(digScoped.data.calls.some((c: any) => c.tool === "node_search" && c.client === UA)).toBe(true);
    expect(digScoped.data.weak.filter((i: any) => i.source === "call").length).toBe(digScoped.data.calls.length);

    const digOwner = await call("dig", { keyword: "mcp" });
    expect(digOwner.data.calls.find((c: any) => c.tool === "node_search")?.input).toContain("mcp");
    // Each dig wrote exactly its own trace of kind dig: three digs, three more rows.
    expect((await traces()).filter((t) => t.kind === "dig").length).toBe(3);
    expect((await traces()).length).toBe(5);
  });

  test("ingress user A never sees a row with ha_user=B: aggregates whole, rows and principals their own", async () => {
    const full = appWith({ apiToken: API_TOKEN, ownerPassphrase: PASSPHRASE, ingressAutoLogin: true, ingressPeer: "172.30.32.2" });
    app = full;
    const { a } = await seed();
    expect((await get(`/api/nodes/${a.id}`, ingressAs("alice"))).status).toBe(200);
    expect((await get(`/api/nodes/${a.id}`, ingressAs("bob"))).status).toBe(200);
    expect((await get(`/api/nodes/${a.id}`)).status).toBe(200);
    expect((await traces()).map((r) => r.ha_user)).toEqual(["alice", "bob", ""]);

    const alice = await json(`/api/trace?node=${a.id}`, ingressAs("alice"));
    expect(alice.count).toBe(3);
    expect(alice.days).toEqual([{ day: "2026-09-07", reads: 3, hits: 3 }]);
    expect(alice.by_method).toEqual({ ingress: 2, "api-token": 1 });
    expect(alice.rows.map((r: any) => r.ha_user)).toEqual(["alice"]);
    expect(alice.principals).toEqual([{ principal: "172.30.32.2", method: "ingress", ha_user: "alice", n: 1 }]);
    expect(JSON.stringify(alice)).not.toContain("bob");

    const bob = await call("trace", { node_id: a.id }, ingressAs("bob"));
    expect(bob.isError).toBe(false);
    expect(bob.data.rows.map((r: any) => r.ha_user)).toEqual(["bob"]);
    expect(JSON.stringify(bob.data)).not.toContain("alice");

    // An ingress caller HA did not name is not admitted at all since 1b-3
    // (PRD §8.1b: no X-Remote-User-Id = nobody signed in → 401, not a deny
    // page). Before 1b-3 this caller was let in and owned nothing.
    const nobody = await get(`/api/trace?node=${a.id}`, { ...ingressAs("alice"), "x-remote-user-id": "" });
    expect(nobody.status).toBe(401);
    expect(nobody.headers.get("www-authenticate")).toContain("Bearer");
    // The owner sees all three.
    expect((await json(`/api/trace?node=${a.id}`)).rows.map((r: any) => r.ha_user)).toEqual(["", "bob", "alice"]);
    expect((await traces()).length).toBe(3);
  });
});
