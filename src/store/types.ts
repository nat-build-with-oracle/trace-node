/**
 * The storage port.
 *
 * Four operations is the whole contract every backend must satisfy. That is
 * deliberately smaller than any ORM's surface: the repository layer already
 * knows exactly which statements it runs (they all live in sql.ts), so what it
 * needs from a driver is not query-building — it is "run this parameterised
 * SQL and give me rows."
 *
 * Keeping the port this narrow is what makes the physical backend swappable:
 *
 *   D1 (Cloudflare Worker)  → store/d1.ts
 *   SQLite (Bun / Tauri)    → store/sqlite.ts
 *   libSQL / Turso          → the same shape; a client with .execute()
 *   Postgres                → the same shape once `?` is rewritten to `$n`
 *
 * The cost of the narrowness, stated honestly: SQL dialect is NOT abstracted.
 * The statements in sql.ts are SQLite-flavoured (FTS5, `INSERT OR IGNORE`), so
 * moving to Postgres means a second statement file, not just a second adapter.
 * That is the right trade for a corpus that is SQLite everywhere it runs today,
 * and it is why this is a port and not an ORM: an ORM would hide the dialect
 * and hide the FTS5 trigram decision with it — the one decision this project
 * most needs to keep visible.
 */

export interface RunResult {
  /** Rows actually changed. Used to tell "deleted" from "was not there". */
  changes: number;
  lastRowId?: number | string;
}

export interface Store {
  /** Every matching row. */
  all<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T[]>;

  /** The first row, or null. */
  first<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T | null>;

  /** A write. */
  run(sql: string, args?: unknown[]): Promise<RunResult>;

  /**
   * Several writes as one unit where the backend supports it.
   * D1 batches them in a single round trip; SQLite wraps them in a
   * transaction. Neither promises cross-statement rollback semantics beyond
   * what the underlying engine gives, so callers must not depend on atomicity
   * they have not verified on their own backend.
   */
  batch(statements: Array<{ sql: string; args?: unknown[] }>): Promise<RunResult[]>;

  /** What this store actually is — surfaced by /health so a deployment can
   *  never leave you guessing which backend answered. */
  readonly driver: string;
}
