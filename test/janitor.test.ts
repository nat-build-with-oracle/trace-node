/**
 * Retention — the janitor (PRD §3.8).
 *
 * Every policy is exercised against rows written straight into the tables,
 * with a frozen clock, so "older than N days" is a fact about the fixture and
 * not about the wall clock on the day the suite runs. The caps are proven
 * with small overrides — the same code path, oldest first — and their
 * defaults are pinned by value.
 *
 * What is never evicted is asserted as often as what is: `trace_days` is the
 * memory, and a janitor that swept it would leave the cloud and the sparkline
 * hollow after 180 days.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createApp } from "../src/app";
import {
  CHECKPOINT_AFTER_DELETES,
  DEFAULT_CAPS,
  DEFAULT_RETENTION,
  HOUSEKEEPING_KEY,
  janitor,
  JANITOR_INTERVAL_MS,
  readHousekeeping,
  WARN_EVICTED_SHARE,
  WARN_FREE_MB,
  type JanitorOptions,
} from "../src/janitor";
import { openSqliteStore } from "../src/store/sqlite";
import type { Store } from "../src/store/types";

const DIR = join(import.meta.dir, "..", "migrations");
const migrations = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({ name: file, sql: readFileSync(join(DIR, file), "utf8") }));

const tmpFile = (tag: string) =>
  join(process.env.TMPDIR ?? "/tmp", `trace-janitor-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

/** A frozen clock (PRD §3.2). */
const T0 = new Date("2026-09-07T03:00:00.000Z");
const clock = () => T0;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(T0.getTime() - ms).toISOString();
const secondsAgo = (s: number) => Math.floor(T0.getTime() / 1000) - s;

const open = () => openSqliteStore(":memory:", migrations);
const count = async (store: Store, table: string) =>
  Number((await store.first<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`))?.c ?? 0);
const quiet: Pick<JanitorOptions, "log" | "warn"> = { log: () => {}, warn: () => {} };
const run = (store: Store, opts: JanitorOptions = {}) => janitor(store, { clock, ...quiet, ...opts });

// ── fixture writers: minimal columns, defaults for the rest ──────────────────

let seq = 0;
const insertTrace = (store: Store, at: string, keyword = "kw") =>
  store.run(
    `INSERT INTO traces (id, at, kind, surface, subject, subject_key, keyword, keyword_norm, hits)
     VALUES (?, ?, 'search', 'http', 'keyword', ?, ?, ?, 1)`,
    [`trace_${++seq}`, at, keyword, keyword, keyword],
  );
const insertDay = (store: Store, day: string, key = "kw") =>
  store.run(
    `INSERT INTO trace_days (subject, subject_key, day, reads, hits, took_ms, last_at, label)
     VALUES ('keyword', ?, ?, 1, 1, 0, ?, ?)`,
    [key, day, `${day}T00:00:00.000Z`, key],
  );
const insertDig = (store: Store, at: string, keyword: string) =>
  store.run(
    `INSERT INTO digs (at, keyword, keyword_norm, friction, confidence, top) VALUES (?, ?, ?, 0.5, 'medium', ?)`,
    [at, keyword, keyword, JSON.stringify([{ source: "term", id: keyword, score: 100 }])],
  );
const insertCall = (store: Store, at: string) =>
  store.run(`INSERT INTO mcp_calls (id, called_at, tool) VALUES (?, ?, 'node_list')`, [`call_${++seq}`, at]);
const insertConnection = (store: Store, id: string, label: string, lastSeen: string) =>
  store.run(
    `INSERT INTO connections (id, method, principal, label, first_seen, last_seen, requests)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [id, id.split(":")[0], id.split(":")[1], label, lastSeen, lastSeen],
  );
const insertClient = (store: Store, id: string, createdAt: string) =>
  store.run(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, '[]', ?)`, [id, id, createdAt]);
const insertToken = (store: Store, clientId: string, expiresAt: number) =>
  store.run(`INSERT INTO oauth_tokens (token_hash, client_id, scope, created_at, expires_at) VALUES (?, ?, 'nodes:read', ?, ?)`, [
    `hash_${++seq}`,
    clientId,
    T0.toISOString(),
    expiresAt,
  ]);
const insertCode = (store: Store, clientId: string, expiresAt: number) =>
  store.run(
    `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
     VALUES (?, ?, 'https://claude.ai/cb', 'c', 'S256', 'nodes:read', ?)`,
    [`code_${++seq}`, clientId, expiresAt],
  );
const insertAttempt = (store: Store, bucket: string, lastAt: number) =>
  store.run(`INSERT INTO auth_attempts (bucket, client_ip, failures, last_at) VALUES (?, '10.0.0.9', 1, ?)`, [bucket, lastAt]);

const FAR_FUTURE = 4_000_000_000; // epoch seconds, 2096

describe("janitor (PRD §3.8)", () => {
  test("traces older than trace_retention_days go (default 180, overridable); trace_days is never touched", async () => {
    const store = await open();
    await insertTrace(store, ago(200 * DAY), "old");
    await insertTrace(store, ago(181 * DAY), "older");
    await insertTrace(store, ago(179 * DAY), "kept");
    await insertTrace(store, ago(10 * DAY), "new");
    for (const day of ["2026-02-19", "2026-03-10", "2026-03-12", "2026-08-28"]) await insertDay(store, day);
    const before = await store.all("SELECT * FROM trace_days ORDER BY day");

    const report = await run(store);
    expect(report.evicted.traces).toBe(2);
    expect((await store.all<{ keyword: string }>("SELECT keyword FROM traces ORDER BY at")).map((r) => r.keyword)).toEqual(["kept", "new"]);
    expect(await store.all("SELECT * FROM trace_days ORDER BY day")).toEqual(before);

    // The option narrows it; the memory still stands.
    expect((await run(store, { traceRetentionDays: 30 })).evicted.traces).toBe(1);
    expect((await store.all<{ keyword: string }>("SELECT keyword FROM traces")).map((r) => r.keyword)).toEqual(["new"]);
    expect(await store.all("SELECT * FROM trace_days ORDER BY day")).toEqual(before);
    expect(DEFAULT_RETENTION.traceDays).toBe(180);
  });

  test("each cap evicts the oldest first — traces 500 000, digs 50 000, calls 100 000, connections 1 000 — and a dig's `top` survives in the kept rows", async () => {
    expect(DEFAULT_CAPS).toEqual({ traces: 500_000, digs: 50_000, calls: 100_000, connections: 1_000 });
    const store = await open();
    for (let i = 0; i < 4; i++) {
      const at = ago((4 - i) * HOUR); // i=0 oldest … i=3 newest
      await insertTrace(store, at, `t${i}`);
      await insertDig(store, at, `d${i}`);
      await insertCall(store, at);
      await insertConnection(store, `api-token:c${i}`, `c${i}`, at);
    }
    const report = await run(store, { caps: { traces: 2, digs: 2, calls: 2, connections: 2 } });
    expect(report.evicted).toMatchObject({ traces: 2, digs: 2, calls: 2, connections: 2 });
    expect((await store.all<{ keyword: string }>("SELECT keyword FROM traces ORDER BY at")).map((r) => r.keyword)).toEqual(["t2", "t3"]);
    const digs = await store.all<{ keyword: string; top: string; dig_seq: number }>("SELECT keyword, top, dig_seq FROM digs ORDER BY at");
    expect(digs.map((d) => [d.keyword, d.dig_seq])).toEqual([["d2", 3], ["d3", 4]]);
    expect(JSON.parse(digs[0]!.top)).toEqual([{ source: "term", id: "d2", score: 100 }]);
    expect(await count(store, "mcp_calls")).toBe(2);
    expect((await store.all<{ id: string }>("SELECT id FROM connections ORDER BY last_seen")).map((r) => r.id)).toEqual(["api-token:c2", "api-token:c3"]);
    // Under the cap nothing moves.
    expect((await run(store, { caps: { traces: 2, digs: 2, calls: 2, connections: 2 } })).evicted).toMatchObject({ traces: 0, digs: 0, calls: 0, connections: 0 });
  });

  test("mcp_calls older than calls_retention_days go (default 90, overridable); newer ones stay", async () => {
    const store = await open();
    await insertCall(store, ago(100 * DAY));
    await insertCall(store, ago(91 * DAY));
    await insertCall(store, ago(89 * DAY));
    await insertCall(store, ago(1 * DAY));
    expect((await run(store)).evicted.calls).toBe(2);
    expect(await count(store, "mcp_calls")).toBe(2);
    expect((await run(store, { callsRetentionDays: 3650 })).evicted.calls).toBe(0);
    expect((await run(store, { callsRetentionDays: 2 })).evicted.calls).toBe(1);
    expect(DEFAULT_RETENTION.callsDays).toBe(90);
  });

  test("connections idle > 90 d go, claude.ai rows survive any age, and the cap spares them too", async () => {
    const store = await open();
    await insertConnection(store, "oauth:abcdefgh12345678", "claude.ai · Claude", ago(400 * DAY));
    await insertConnection(store, "api-token:curl", "curl", ago(100 * DAY));
    await insertConnection(store, "ingress:172.30.32.2", "HA sidebar", ago(1 * DAY));

    expect((await run(store)).evicted.connections).toBe(1);
    expect((await store.all<{ id: string }>("SELECT id FROM connections ORDER BY last_seen")).map((r) => r.id)).toEqual([
      "oauth:abcdefgh12345678",
      "ingress:172.30.32.2",
    ]);
    // Cap 1 with two rows left: the oldest NON-claude.ai row goes, not the oldest row.
    expect((await run(store, { caps: { connections: 1 } })).evicted.connections).toBe(1);
    expect((await store.all<{ id: string }>("SELECT id FROM connections")).map((r) => r.id)).toEqual(["oauth:abcdefgh12345678"]);
  });

  test("sweepExpired runs (expired codes and tokens gone, live ones kept); never-authorized clients gone after 24 h, authorized, seen or recent ones kept", async () => {
    const store = await open();
    await insertClient(store, "c_never", ago(25 * HOUR));
    await insertToken(store, "c_never", 1);
    await insertCode(store, "c_never", 1);
    await insertClient(store, "c_live", ago(25 * HOUR));
    await insertToken(store, "c_live", FAR_FUTURE);
    await insertClient(store, "c_pending", ago(25 * HOUR));
    await insertCode(store, "c_pending", FAR_FUTURE);
    await insertClient(store, "c_new", ago(1 * HOUR));
    await insertClient(store, "c_seen", ago(30 * DAY));
    await insertConnection(store, "oauth:c_seen", "claude.ai · Claude", ago(20 * DAY));

    const report = await run(store);
    expect(report.evicted).toMatchObject({ oauth_codes: 1, oauth_tokens: 1, oauth_clients: 1 });
    expect((await store.all<{ client_id: string }>("SELECT client_id FROM oauth_clients ORDER BY client_id")).map((r) => r.client_id)).toEqual([
      "c_live",
      "c_new",
      "c_pending",
      "c_seen",
    ]);
    expect(await count(store, "oauth_tokens")).toBe(1);
    expect(await count(store, "oauth_codes")).toBe(1);
    expect(DEFAULT_RETENTION.clientsHours).toBe(24);
  });

  test("auth_attempts older than 24 h are dropped — bearer, register and dig buckets included — and recent ones stay", async () => {
    const store = await open();
    await insertAttempt(store, "bearer", secondsAgo(25 * 3600));
    await insertAttempt(store, "register", secondsAgo(26 * 3600));
    await insertAttempt(store, "dig", secondsAgo(48 * 3600));
    await insertAttempt(store, "login", secondsAgo(23 * 3600));
    await insertAttempt(store, "authorize", secondsAgo(60));
    expect((await run(store)).evicted.auth_attempts).toBe(3);
    expect((await store.all<{ bucket: string }>("SELECT bucket FROM auth_attempts ORDER BY bucket")).map((r) => r.bucket)).toEqual(["authorize", "login"]);
  });

  test("PRAGMA journal_mode is `wal` on a file store and `memory` on :memory:, busy_timeout 5000; wal_checkpoint(PASSIVE) runs only after > 1 000 deletes", async () => {
    const pragma = async (store: Store, name: string) => (await store.first<Record<string, unknown>>(`PRAGMA ${name}`)) as unknown;
    const memory = await open();
    expect(await pragma(memory, "journal_mode")).toEqual({ journal_mode: "memory" });
    expect(await pragma(memory, "busy_timeout")).toEqual({ timeout: 5000 });
    const file = await openSqliteStore(tmpFile("wal"), migrations);
    expect(await pragma(file, "journal_mode")).toEqual({ journal_mode: "wal" });
    expect(await pragma(file, "busy_timeout")).toEqual({ timeout: 5000 });

    // A store that remembers every statement it ran.
    const spy = (inner: Store) => {
      const ran: string[] = [];
      const store: Store = {
        driver: inner.driver,
        all: (sql, args) => inner.all(sql, args),
        first: (sql, args) => inner.first(sql, args),
        run: (sql, args) => {
          ran.push(sql);
          return inner.run(sql, args);
        },
        batch: (statements) => inner.batch(statements),
      };
      return { store, ran };
    };

    expect(CHECKPOINT_AFTER_DELETES).toBe(1000);
    const big = spy(file);
    await file.batch(Array.from({ length: 1001 }, (_, i) => ({
      sql: `INSERT INTO traces (id, at, kind, surface, subject, subject_key, keyword, keyword_norm) VALUES (?, ?, 'search', 'http', 'keyword', 'k', 'k', 'k')`,
      args: [`trace_big_${i}`, ago(200 * DAY)],
    })));
    const report = await run(big.store);
    expect(report.evicted.traces).toBe(1001);
    expect(report.checkpointed).toBe(true);
    expect(big.ran.filter((sql) => sql === "PRAGMA wal_checkpoint(PASSIVE)").length).toBe(1);

    const small = spy(await open());
    for (let i = 0; i < 5; i++) await insertTrace(small.store, ago(200 * DAY));
    const few = await run(small.store);
    expect(few.evicted.traces).toBe(5);
    expect(few.checkpointed).toBe(false);
    expect(small.ran.some((sql) => sql.includes("wal_checkpoint"))).toBe(false);
  });

  test("settings.housekeeping holds the report; /api/health and `status` mirror it with retention and protocol_versions_seen", async () => {
    const store = await open();
    const app = createApp({ store, instanceName: "test", clock, retention: { traceDays: 30 } });
    const health = async () => (await (await app.fetch(new Request("http://localhost/api/health"))).json()) as any;

    // Before the first run: said, not invented.
    const first = await health();
    expect(first.housekeeping).toBeNull();
    expect(first.retention).toEqual({ trace_days: 30, calls_days: 90 });
    expect(first).toMatchObject({ traces: 0, digs: 0, protocol_versions_seen: [] });
    expect(await readHousekeeping(store)).toBeNull();

    await insertTrace(store, ago(200 * DAY));
    await insertTrace(store, ago(1 * DAY));
    await insertDig(store, ago(1 * DAY), "kw");
    const report = await run(store, { traceRetentionDays: 30 });

    const stored = await store.first<{ value: string }>("SELECT value FROM settings WHERE key = ?", [HOUSEKEEPING_KEY]);
    expect(JSON.parse(stored!.value)).toEqual(report);
    expect(await readHousekeeping(store)).toEqual(report);
    expect(report).toMatchObject({
      last_at: T0.toISOString(),
      next_at: new Date(T0.getTime() + JANITOR_INTERVAL_MS).toISOString(),
      traces_before: 2,
      evicted: { traces: 1, digs: 0, calls: 0, connections: 0, oauth_codes: 0, oauth_tokens: 0, oauth_clients: 0, auth_attempts: 0 },
      checkpointed: false,
      data_free_mb: null,
      warned: true,
      errors: [],
    });
    expect(JANITOR_INTERVAL_MS).toBe(10 * 60 * 1000);

    await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
      }),
    );
    const after = await health();
    expect(after.housekeeping).toEqual({
      last_at: report.last_at,
      next_at: report.next_at,
      evicted: report.evicted,
      data_free_mb: null,
      warned: true,
      errors: [],
    });
    expect(after).toMatchObject({ traces: 1, digs: 1, protocol_versions_seen: ["2025-11-25"] });

    const status = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } }),
      }),
    );
    const body = JSON.parse(((await status.json()) as any).result.content[0].text);
    expect(body).toMatchObject({ traces_24h: 1, digs: 1, housekeeping: report });
    expect(body.top_keyword_7d).toBeNull();
  });

  test("one free-space line per run (warns below 200 MB); `warned` when > 10 % of traces go in one run, not at 10 %", async () => {
    expect(WARN_EVICTED_SHARE).toBe(0.1);
    expect(WARN_FREE_MB).toBe(200);
    const lines: string[] = [];
    const warnings: string[] = [];
    const capture = { log: (l: string) => lines.push(l), warn: (l: string) => warnings.push(l) };

    // A real directory: the line carries a number; no dataDir: it says so.
    const store = await open();
    const withDir = await run(store, { ...capture, dataDir: process.env.TMPDIR ?? "/tmp" });
    expect(typeof withDir.data_free_mb).toBe("number");
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^\[janitor\] free=\d+ MB /);
    const withoutDir = await run(store, capture);
    expect(withoutDir.data_free_mb).toBeNull();
    expect(lines.length).toBe(2);
    expect(lines[1]).toMatch(/^\[janitor\] free=unknown /);
    expect(warnings).toEqual([]);
    // A directory that does not exist is "unknown", never a throw.
    expect((await run(store, { ...capture, dataDir: "/nonexistent/trace-node" })).data_free_mb).toBeNull();

    // 20 of 100 old → 20 % → warned; 10 of 100 → exactly 10 % → not.
    const flood = await open();
    for (let i = 0; i < 100; i++) await insertTrace(flood, i < 20 ? ago(200 * DAY) : ago(1 * DAY));
    const loud = await run(flood, capture);
    expect(loud).toMatchObject({ traces_before: 100, warned: true });
    expect(loud.evicted.traces).toBe(20);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("evicted 20 of 100 traces");

    const edge = await open();
    for (let i = 0; i < 100; i++) await insertTrace(edge, i < 10 ? ago(200 * DAY) : ago(1 * DAY));
    const calm = await run(edge, capture);
    expect(calm).toMatchObject({ traces_before: 100, warned: false });
    expect(calm.evicted.traces).toBe(10);
    expect(warnings.length).toBe(1);
    // An empty table is never a flood.
    expect((await run(await open(), capture)).warned).toBe(false);
  });

  test("never throws on a broken store: dropped tables become listed errors, the rest still runs, the report is still written", async () => {
    const store = await open();
    await insertCall(store, ago(100 * DAY));
    await store.run("DROP TABLE traces");
    await store.run("DROP TABLE digs");
    await store.run("DROP TABLE oauth_clients");

    const report = await run(store);
    expect(report.errors.length).toBeGreaterThanOrEqual(3);
    expect(report.errors.some((e) => e.startsWith("traces."))).toBe(true);
    expect(report.errors.some((e) => e.startsWith("digs."))).toBe(true);
    expect(report.errors.some((e) => e.startsWith("oauth.clients"))).toBe(true);
    // Policies on intact tables still ran.
    expect(report.evicted.calls).toBe(1);
    expect(report.warned).toBe(false);
    expect(await readHousekeeping(store)).toEqual(report);

    // A store that refuses everything: still a report, still no throw.
    const dead: Store = {
      driver: "dead",
      all: async () => {
        throw new Error("gone");
      },
      first: async () => {
        throw new Error("gone");
      },
      run: async () => {
        throw new Error("gone");
      },
      batch: async () => {
        throw new Error("gone");
      },
    };
    const worst = await run(dead);
    expect(worst.errors.length).toBeGreaterThanOrEqual(10);
    expect(worst.errors.some((e) => e.startsWith("settings:"))).toBe(true);
    expect(worst.evicted).toEqual({ traces: 0, digs: 0, calls: 0, connections: 0, oauth_codes: 0, oauth_tokens: 0, oauth_clients: 0, auth_attempts: 0 });
    expect(await readHousekeeping(dead)).toBeNull();
  });
});
