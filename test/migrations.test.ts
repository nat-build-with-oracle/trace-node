/**
 * The additive migrations after digger's seven (PRD §3.2, §8.1a): 0008/0009
 * at gate 1a, and 0010 — a plain `CREATE INDEX IF NOT EXISTS`, added at 1b-6
 * once the 500 k-trace perf fixture measured `digs`' budget queries scanning
 * the whole table (PRD §8.1b, §10: "must show index use").
 *
 * 0009 carries an `ALTER TABLE … ADD COLUMN`, which — like 0004's RENAME — is
 * the shape of migration that succeeds once and fails forever. Every test here
 * opens a FILE more than once, because that is the case a fresh `:memory:`
 * suite never meets and the case a restarted add-on always does.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { openSqliteStore } from "../src/store/sqlite";

const DIR = join(import.meta.dir, "..", "migrations");
const migrationFiles = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({ name: file, sql: readFileSync(join(DIR, file), "utf8") }));

/** digger's seven, byte-identical (PRD §3.2), and trace-node's two after them. */
const inherited = migrationFiles.filter((m) => m.name < "0008");
const added = migrationFiles.filter((m) => m.name >= "0008");

const tmpFile = (tag: string) =>
  join(process.env.TMPDIR ?? "/tmp", `trace-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

const columns = async (store: { all: <T>(sql: string, args?: unknown[]) => Promise<T[]> }, table: string) =>
  (await store.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name);

describe("migrations 0008 + 0009 + 0010", () => {
  test("the set is exactly the inherited seven plus 0008_traces, 0009_digs and 0010_digs_budget_idx", () => {
    expect(inherited.map((m) => m.name)).toEqual([
      "0001_init.sql",
      "0002_embeddings.sql",
      "0003_oauth.sql",
      "0004_oauth_hashed.sql",
      "0005_rate_limit.sql",
      "0006_settings.sql",
      "0007_connections.sql",
    ]);
    expect(added.map((m) => m.name)).toEqual(["0008_traces.sql", "0009_digs.sql", "0010_digs_budget_idx.sql"]);
  });

  test("0010 is a plain CREATE INDEX IF NOT EXISTS on digs(method, principal, at) — the dig budget's missing index (1b-6 perf fixture)", async () => {
    const store = await openSqliteStore(":memory:", migrationFiles);
    const indexes = await store.all<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'digs' ORDER BY name",
    );
    const budget = indexes.find((i) => i.name === "digs_budget");
    expect(budget).toBeDefined();
    expect(budget!.sql).toContain("digs(method, principal, at DESC)");
  });

  test("two opens of one file: 0009's ALTER runs once and the columns exist once", async () => {
    const path = tmpFile("two-open");
    const first = await openSqliteStore(path, migrationFiles);
    await first.run(
      "INSERT INTO mcp_calls (id, called_at, tool, method, principal) VALUES (?, ?, ?, ?, ?)",
      ["call_1", "2026-09-07T00:00:00.000Z", "node_search", "api-token", "curl"],
    );

    // Before the ledger this second open died on the duplicate column.
    const second = await openSqliteStore(path, migrationFiles);
    const cols = await columns(second, "mcp_calls");
    expect(cols.filter((c) => c === "method")).toEqual(["method"]);
    expect(cols.filter((c) => c === "principal")).toEqual(["principal"]);
    const row = await second.first<{ method: string; principal: string }>(
      "SELECT method, principal FROM mcp_calls WHERE id = ?",
      ["call_1"],
    );
    expect(row).toEqual({ method: "api-token", principal: "curl" });
    const ledger = await second.all<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
    expect(ledger.map((r) => r.name)).toEqual(migrationFiles.map((m) => m.name));
    for (const table of ["traces", "trace_days", "digs"]) {
      expect(await second.first("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table])).not.toBeNull();
    }
  });

  test("a backup of the fork — 0001–0007 with their ledger rows — opens with 0008, 0009 and 0010 newly applied", async () => {
    const path = tmpFile("fork-backup");
    const { Database } = await import("bun:sqlite");
    const raw = new Database(path);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const APPLIED = "2026-08-01T00:00:00.000Z";
    for (const m of inherited) {
      raw.exec(m.sql);
      raw.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(m.name, APPLIED);
    }
    // digger's ledger rows: the 8-column mcp_calls shape and a node.
    raw
      .query("INSERT INTO nodes (title, body, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("kept", "b", "note", APPLIED, APPLIED);
    raw
      .query("INSERT INTO mcp_calls (id, called_at, tool, input, outcome, result, duration_ms, client) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("call_old", APPLIED, "node_list", "{}", "ok", "[]", 3, "curl");
    raw.close();

    const store = await openSqliteStore(path, migrationFiles);
    const ledger = await store.all<{ name: string; applied_at: string }>(
      "SELECT name, applied_at FROM schema_migrations ORDER BY name",
    );
    expect(ledger.map((r) => r.name)).toEqual(migrationFiles.map((m) => m.name));
    // The seven keep their original stamp: nothing was re-run.
    expect(ledger.filter((r) => r.name < "0008").every((r) => r.applied_at === APPLIED)).toBe(true);
    expect(ledger.filter((r) => r.name >= "0008").every((r) => r.applied_at !== APPLIED)).toBe(true);

    // The data survived and the old call reads back with the new DEFAULTs.
    expect((await store.all<{ title: string }>("SELECT title FROM nodes")).map((r) => r.title)).toEqual(["kept"]);
    const old = await store.first<{ method: string; principal: string; client: string }>(
      "SELECT method, principal, client FROM mcp_calls WHERE id = ?",
      ["call_old"],
    );
    expect(old).toEqual({ method: "", principal: "", client: "curl" });
    expect(await columns(store, "traces")).toContain("keyword_norm");
    expect(await columns(store, "trace_days")).toContain("label");
    expect(await columns(store, "digs")).toContain("dig_seq");
  });

  test("PRAGMA foreign_key_check is empty after every file, applied one at a time", async () => {
    const { Database } = await import("bun:sqlite");
    const raw = new Database(":memory:");
    raw.exec("PRAGMA foreign_keys = ON");
    for (const m of migrationFiles) {
      raw.exec(m.sql);
      const violations = raw.query("PRAGMA foreign_key_check").all();
      expect({ after: m.name, violations }).toEqual({ after: m.name, violations: [] });
    }
    // And the ledger path agrees on a file that is then reopened.
    const path = tmpFile("fk");
    const store = await openSqliteStore(path, migrationFiles);
    expect(await store.all("PRAGMA foreign_key_check")).toEqual([]);
    const again = await openSqliteStore(path, migrationFiles);
    expect(await again.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
