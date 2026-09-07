/**
 * Retention — the janitor (PRD §3.8).
 *
 * Runs at boot and every ten minutes (server.ts, an unref'd interval), self-
 * hosted only. Each policy is ONE statement, each step is wrapped so a failure
 * is a line in the report and never a throw: a housekeeper that can take the
 * service down is worse than dust. Totals go to `settings.housekeeping` and
 * from there to `/api/health` and the `status` tool.
 *
 * What is NEVER evicted: `trace_days` — the memory that lets the `all` cloud
 * and a keyword's sparkline outlive the raw log.
 *
 * What is deliberately absent: VACUUM. The container has no TZ, VACUUM takes an
 * exclusive lock on a live file, and it is no gate-1 value; DOCS.md says to run
 * it by hand after `ha addons stop`.
 */

import { statfsSync } from "node:fs";

import { sweepExpired } from "./oauth";
import { JANITOR, SETTINGS } from "./sql";
import type { Store } from "./store/types";
import { nowIso, type Clock } from "./utils";

/** The settings row the report lives in. */
export const HOUSEKEEPING_KEY = "housekeeping";
/** Every ten minutes — hybrid §6, not evolve's hour. */
export const JANITOR_INTERVAL_MS = 10 * 60 * 1000;

/** The caps (PRD §3.8), oldest first past each. */
export const DEFAULT_CAPS = {
  traces: 500_000,
  digs: 50_000,
  calls: 100_000,
  connections: 1_000,
} as const;

export const DEFAULT_RETENTION = {
  /** `trace_retention_days` (add-on option). */
  traceDays: 180,
  /** `calls_retention_days` (add-on option). */
  callsDays: 90,
  /** Idle connections, except claude.ai's. Not an option. */
  connectionsDays: 90,
  /** Registrations never authorised. Not an option. */
  clientsHours: 24,
  /** `auth_attempts` buckets. Not an option. */
  attemptsHours: 24,
} as const;

/** A run that evicts more than this share of `traces` is a tamper signal. */
export const WARN_EVICTED_SHARE = 0.1;
/** The free-space line warns below this (PRD §3.8; memory `c8a5b316`). */
export const WARN_FREE_MB = 200;
/** A run deleting more rows than this ends with a WAL checkpoint. */
export const CHECKPOINT_AFTER_DELETES = 1000;

export interface JanitorOptions {
  clock?: Clock;
  traceRetentionDays?: number;
  callsRetentionDays?: number;
  /** Override a cap (tests prove "oldest first" with small ones). */
  caps?: Partial<Record<keyof typeof DEFAULT_CAPS, number>>;
  /** The directory whose free space is reported — `/data` in the add-on. Omit for `:memory:`. */
  dataDir?: string;
  /** Where the one line per run goes. Defaults to console. */
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface Evicted {
  traces: number;
  digs: number;
  calls: number;
  connections: number;
  oauth_codes: number;
  oauth_tokens: number;
  oauth_clients: number;
  auth_attempts: number;
}

export interface Housekeeping {
  last_at: string;
  next_at: string;
  took_ms: number;
  evicted: Evicted;
  /** Rows before the run, so the 10 % rule is auditable. */
  traces_before: number;
  checkpointed: boolean;
  data_free_mb: number | null;
  warned: boolean;
  errors: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const clampDays = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && (value as number) >= 1 ? Math.min(Math.trunc(value as number), 3650) : fallback;

/** Free megabytes on the filesystem holding `dir`, or null when unknowable. */
export function freeMb(dir: string | undefined): number | null {
  if (!dir) return null;
  try {
    const s = statfsSync(dir);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

/**
 * One pass over every table with a policy. Never throws; returns what it did.
 */
export async function janitor(store: Store, opts: JanitorOptions = {}): Promise<Housekeeping> {
  const started = Date.now();
  const now = opts.clock ? opts.clock() : new Date();
  const log = opts.log ?? ((line: string) => console.log(line));
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  const caps: Record<keyof typeof DEFAULT_CAPS, number> = { ...DEFAULT_CAPS, ...(opts.caps ?? {}) };
  const traceDays = clampDays(opts.traceRetentionDays, DEFAULT_RETENTION.traceDays);
  const callsDays = clampDays(opts.callsRetentionDays, DEFAULT_RETENTION.callsDays);
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

  const evicted: Evicted = { traces: 0, digs: 0, calls: 0, connections: 0, oauth_codes: 0, oauth_tokens: 0, oauth_clients: 0, auth_attempts: 0 };
  const errors: string[] = [];
  let tracesBefore = 0;

  /** One policy: run it, count it, never let it escape. */
  const step = async (name: string, fn: () => Promise<number>): Promise<number> => {
    try {
      return await fn();
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  };
  const count = async (sql: string): Promise<number> => Number((await store.first<{ c: number }>(sql))?.c ?? 0);
  /** Past the cap → delete the oldest `over` rows. Computed here, never as a SQL subtraction. */
  const capped = async (countSql: string, oldestSql: string, cap: number): Promise<number> => {
    const over = (await count(countSql)) - cap;
    return over > 0 ? (await store.run(oldestSql, [over])).changes : 0;
  };

  tracesBefore = await step("traces.count", () => count(JANITOR.traces.count));
  evicted.traces += await step("traces.days", async () => (await store.run(JANITOR.traces.olderThan, [iso(traceDays * DAY_MS)])).changes);
  evicted.traces += await step("traces.cap", () => capped(JANITOR.traces.count, JANITOR.traces.oldest, caps.traces));
  // trace_days: deliberately no statement. The memory is never evicted.
  evicted.digs += await step("digs.cap", () => capped(JANITOR.digs.count, JANITOR.digs.oldest, caps.digs));
  evicted.calls += await step("calls.days", async () => (await store.run(JANITOR.calls.olderThan, [iso(callsDays * DAY_MS)])).changes);
  evicted.calls += await step("calls.cap", () => capped(JANITOR.calls.count, JANITOR.calls.oldest, caps.calls));
  evicted.connections += await step(
    "connections.idle",
    async () => (await store.run(JANITOR.connections.idle, [iso(DEFAULT_RETENTION.connectionsDays * DAY_MS)])).changes,
  );
  evicted.connections += await step("connections.cap", () => capped(JANITOR.connections.count, JANITOR.connections.oldest, caps.connections));
  await step("oauth.sweep", async () => {
    const swept = await sweepExpired(store);
    evicted.oauth_codes += swept.codes;
    evicted.oauth_tokens += swept.tokens;
    return swept.codes + swept.tokens;
  });
  evicted.oauth_clients += await step(
    "oauth.clients",
    async () => (await store.run(JANITOR.oauthClients.neverAuthorized, [iso(DEFAULT_RETENTION.clientsHours * HOUR_MS)])).changes,
  );
  evicted.auth_attempts += await step(
    "auth_attempts",
    async () => (await store.run(JANITOR.authAttempts.olderThan, [Math.floor((now.getTime() - DEFAULT_RETENTION.attemptsHours * HOUR_MS) / 1000)])).changes,
  );

  const deleted = Object.values(evicted).reduce((sum, n) => sum + n, 0);
  let checkpointed = false;
  if (deleted > CHECKPOINT_AFTER_DELETES) {
    checkpointed = (await step("checkpoint", async () => {
      await store.run(JANITOR.checkpoint);
      return 1;
    })) === 1;
  }

  // The tamper signal (PRD §3.8): a flooder can push old rows out of the raw
  // log; when one run evicts more than a tenth of it, say so and flag it.
  const warned = tracesBefore > 0 && evicted.traces / tracesBefore > WARN_EVICTED_SHARE;
  if (warned) {
    warn(`[janitor] WARNING: evicted ${evicted.traces} of ${tracesBefore} traces (> ${WARN_EVICTED_SHARE * 100}%) in one run — a flood, or retention just tightened`);
  }

  const dataFreeMb = freeMb(opts.dataDir);
  const free = dataFreeMb === null ? "unknown" : `${dataFreeMb} MB`;
  if (dataFreeMb !== null && dataFreeMb < WARN_FREE_MB) {
    warn(`[janitor] WARNING: ${opts.dataDir} has ${free} free (< ${WARN_FREE_MB} MB)`);
  }
  log(
    `[janitor] free=${free} evicted traces=${evicted.traces} digs=${evicted.digs} calls=${evicted.calls} ` +
      `connections=${evicted.connections} oauth=${evicted.oauth_codes + evicted.oauth_tokens + evicted.oauth_clients} ` +
      `attempts=${evicted.auth_attempts}${checkpointed ? " checkpoint=yes" : ""}${errors.length ? ` errors=${errors.length}` : ""}`,
  );

  const report: Housekeeping = {
    last_at: now.toISOString(),
    next_at: new Date(now.getTime() + JANITOR_INTERVAL_MS).toISOString(),
    took_ms: Date.now() - started,
    evicted,
    traces_before: tracesBefore,
    checkpointed,
    data_free_mb: dataFreeMb,
    warned,
    errors,
  };
  await step("settings", async () => {
    await store.run(SETTINGS.put, [HOUSEKEEPING_KEY, JSON.stringify(report), nowIso(opts.clock)]);
    return 1;
  });
  return report;
}

/** The last report, as `/api/health` and `status` show it; null before the first run. */
export async function readHousekeeping(store: Store): Promise<Housekeeping | null> {
  try {
    const row = await store.first<{ value: string }>(SETTINGS.get, [HOUSEKEEPING_KEY]);
    return row ? (JSON.parse(row.value) as Housekeeping) : null;
  } catch {
    return null;
  }
}

/**
 * Boot run, then every ten minutes. The interval is unref'd so it never keeps
 * a process alive that has otherwise finished. Returns the stop function.
 */
export function startJanitor(store: Store, opts: JanitorOptions = {}): () => void {
  const run = () => janitor(store, opts).catch(() => {});
  void run();
  const timer = setInterval(run, JANITOR_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
