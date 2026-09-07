/**
 * SQLite adapter — for tests, for local CLI use, and for the desktop client.
 *
 * This is the file that makes the port worth having. The same repository code,
 * the same statements in sql.ts, and the same MCP tool handlers run:
 *
 *   - on a Cloudflare Worker against D1,
 *   - in `bun test` against an in-memory database (no wrangler, no network),
 *   - inside a Tauri app against a file on the user's own disk.
 *
 * Only this file changes between them.
 *
 * Imported lazily via a dynamic `bun:sqlite` import so a Workers bundle that
 * never calls sqliteStore() does not try to resolve a Node/Bun builtin.
 */

import type { RunResult, Store } from "./types";

export interface SqliteLike {
  query(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): { changes?: number; lastInsertRowid?: number | bigint };
  };
  exec?(sql: string): void;
  transaction?<T>(fn: () => T): () => T;
}

/**
 * Wrap an already-open bun:sqlite (or API-compatible) database.
 * Kept separate from `openSqliteStore` so a caller that manages its own handle
 * — a Tauri app holding one connection for the process lifetime — can use it.
 */
export function sqliteStore(database: SqliteLike): Store {
  const rows = <T>(sql: string, args: unknown[]): T[] =>
    database.query(sql).all(...args) as T[];

  return {
    driver: "sqlite",

    async all<T>(sql: string, args: unknown[] = []): Promise<T[]> {
      return rows<T>(sql, args);
    },

    async first<T>(sql: string, args: unknown[] = []): Promise<T | null> {
      return (database.query(sql).get(...args) as T | undefined) ?? null;
    },

    async run(sql: string, args: unknown[] = []): Promise<RunResult> {
      const result = database.query(sql).run(...args);
      return {
        changes: result?.changes ?? 0,
        lastRowId:
          typeof result?.lastInsertRowid === "bigint"
            ? Number(result.lastInsertRowid)
            : result?.lastInsertRowid,
      };
    },

    async batch(statements): Promise<RunResult[]> {
      if (statements.length === 0) return [];
      const apply = () =>
        statements.map((s) => {
          const result = database.query(s.sql).run(...(s.args ?? []));
          return { changes: result?.changes ?? 0 };
        });
      // A real transaction where the driver offers one; a plain loop otherwise.
      return database.transaction ? database.transaction(apply)() : apply();
    },
  };
}

/**
 * Open a SQLite file (or `:memory:`) and apply the migrations in order.
 *
 * Migrations are read as text and passed in by the caller rather than read from
 * disk here, so this works identically in a test, a CLI, and a bundled app that
 * has no filesystem layout to assume.
 */
export async function openSqliteStore(
  path: string,
  migrations: Array<string | { name: string; sql: string }> = [],
): Promise<Store> {
  const { Database } = (await import("bun:sqlite")) as {
    Database: new (path: string) => SqliteLike & { exec(sql: string): void };
  };
  const database = new Database(path);
  // Foreign keys are OFF by default in SQLite — the ON DELETE CASCADE rules in
  // the schema are inert without this, and node_terms rows would outlive their
  // nodes. D1 enables them for you; a local file does not.
  database.exec("PRAGMA foreign_keys = ON");
  // WAL and a busy timeout (PRD §3.8): the janitor deletes in bulk every ten
  // minutes on a live file, and readers must not queue behind it. On
  // `:memory:` SQLite answers `memory` to the first pragma and that is fine —
  // the test asserts exactly that split. A checkpoint after a big eviction is
  // only meaningful because of this line.
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");

  /**
   * Each migration runs AT MOST ONCE, tracked in a table.
   *
   * The first version of this applied every file on every open, on the belief
   * that migrations are idempotent. They are not, and the counter-example is
   * already in this repository: 0004 is
   *
   *     ALTER TABLE oauth_codes RENAME COLUMN code TO code_hash;
   *
   * which succeeds once and then fails forever with `no such column: "code"`.
   * A fresh database was fine, so tests passed and the first boot of a
   * deployment passed; the SECOND boot — the first restart, the first update —
   * died on startup. The Worker path never met this because
   * `wrangler d1 migrations apply` has always kept a ledger. This is that
   * ledger, and it is what makes "start it again" a safe recovery step rather
   * than a claim.
   *
   * Applied inside a transaction with its bookkeeping, so a migration that
   * fails partway cannot be recorded as done.
   */
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (database.query("SELECT name FROM schema_migrations").all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );

  /**
   * The upgrade case: a database that predates this ledger.
   *
   * Such a file has real tables and an empty ledger, and the strict path would
   * try to re-run everything and die on 0004 — which is precisely what a
   * deployed add-on did. Its migrations HAVE been applied; the only thing
   * missing is the record.
   *
   * So the first pass over an already-populated database is tolerant: run each
   * migration, and if it fails, take that as evidence it was already applied,
   * record it, and say so. This happens once. Afterwards the ledger is accurate
   * and every later open is strict, so a genuine error can never be swallowed
   * twice.
   *
   * "Populated" is decided by a table from 0001 rather than by file size, so a
   * database that exists but was never migrated still gets the strict path.
   */
  const preexisting =
    (database
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'")
      .get() as { name: string } | undefined | null) != null;
  const baseline = applied.size === 0 && preexisting;

  for (const entry of migrations) {
    // A bare string keeps the old call shape working. Its identity is a hash of
    // its own text, so the same SQL is recognised across runs and edited SQL is
    // treated as a new migration rather than silently skipped.
    const { name, sql } =
      typeof entry === "string"
        ? { name: `sha:${Bun.hash(entry).toString(16)}`, sql: entry }
        : entry;
    if (applied.has(name)) continue;

    const record = () =>
      database
        .query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(name, new Date().toISOString());

    // The migration and its bookkeeping commit together or not at all, so a
    // file that fails halfway can never be left recorded as done — which would
    // skip it forever and leave the schema permanently half-built.
    const apply = () => {
      database.exec(sql);
      record();
    };

    try {
      if (database.transaction) database.transaction(apply)();
      else apply();
    } catch (error) {
      if (!baseline) throw error;
      // Adopting, not ignoring: this runs only on the one pass that adopts a
      // pre-ledger database, and the reason is printed rather than hidden.
      console.log(
        `[migrations] adopting ${name} as already applied ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
      record();
    }
  }

  return sqliteStore(database);
}
