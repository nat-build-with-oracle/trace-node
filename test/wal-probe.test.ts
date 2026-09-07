/**
 * trace-node#1 — the WAL probe and the journal-mode fallback.
 *
 * On kvmlab1 `PRAGMA journal_mode = WAL` blocked forever. A blocked thread
 * cannot time itself out, so the probe is a child process with a deadline.
 * These tests cover: the real child on a healthy volume; a simulated hang
 * (`sleep`) killed at the deadline; a failing child; and every branch of
 * openSqliteStore's decision — auto/ok, auto/fail, wal, delete, :memory:.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSqliteStore, parseJournalMode, type OpenSqliteOptions } from "../src/store/sqlite";
import type { Store } from "../src/store/types";
import { probeFileFor, walProbe } from "../src/store/wal-probe";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const migrations = readdirSync(MIGRATIONS)
  .filter((n) => n.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf8") }));

const scratchDir = () => mkdtempSync(join(tmpdir(), "trace-node-wal-"));
const journalMode = async (store: Store) =>
  ((await store.first<{ journal_mode: string }>("PRAGMA journal_mode"))?.journal_mode ?? "").toLowerCase();

describe("walProbe", () => {
  test("a healthy volume answers ok, quickly, and leaves no scratch file behind", async () => {
    const dir = scratchDir();
    const result = await walProbe(join(dir, "trace.db"));
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/^ok in \d+ms$/);
    expect(result.ms).toBeLessThan(3000);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a hung probe is killed at the deadline and reported as a timeout — the boot never waits on it", async () => {
    const dir = scratchDir();
    const started = Date.now();
    const result = await walProbe(join(dir, "trace.db"), { timeoutMs: 200, command: ["sleep", "30"] });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timed out after 200ms");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a child that exits non-zero is a no, with the exit code and its first stderr line", async () => {
    const dir = scratchDir();
    const result = await walProbe(join(dir, "trace.db"), {
      command: ["sh", "-c", "echo 'disk says no' >&2; exit 2"],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("exit 2 (disk says no)");
  });

  test("a command that cannot be spawned is a no, not a throw", async () => {
    const result = await walProbe(join(scratchDir(), "trace.db"), { command: ["/definitely/not/a/binary"] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^could not spawn/);
  });

  test("the scratch file lives next to the corpus, so it is the corpus's volume that is tested", () => {
    const file = probeFileFor("/data/trace.db");
    expect(file.startsWith("/data/.wal-probe-")).toBe(true);
    expect(file.endsWith(".sqlite")).toBe(true);
  });
});

describe("openSqliteStore journal mode", () => {
  const lines: string[] = [];
  const opts = (extra: OpenSqliteOptions = {}): OpenSqliteOptions => ({ log: (l) => lines.push(l), ...extra });

  test("auto + probe ok → wal, logged", async () => {
    lines.length = 0;
    const store = await openSqliteStore(join(scratchDir(), "t.db"), migrations, opts({ probe: async () => ({ ok: true, reason: "ok in 1ms", ms: 1 }) }));
    expect(await journalMode(store)).toBe("wal");
    expect(lines).toEqual(["trace-node: journal_mode=wal (WAL probe ok in 1ms)"]);
  });

  test("auto + probe timed out → delete, the reason and the issue in the log, and the store still works", async () => {
    lines.length = 0;
    const store = await openSqliteStore(
      join(scratchDir(), "t.db"),
      migrations,
      opts({ probe: async () => ({ ok: false, reason: "timed out after 3000ms", ms: 3000 }) }),
    );
    expect(await journalMode(store)).toBe("delete");
    expect(lines).toEqual([
      "trace-node: journal_mode=delete — WAL probe timed out after 3000ms; falling back to the rollback journal (trace-node#1)",
    ]);
    // Migrations ran and the schema is usable without WAL.
    expect((await store.first<{ n: number }>("SELECT count(*) AS n FROM schema_migrations"))?.n).toBe(migrations.length);
    await store.run("INSERT INTO vocabularies (id, name, created_at) VALUES ('v1', 'probe', 1)");
    expect((await store.first<{ n: number }>("SELECT count(*) AS n FROM vocabularies"))?.n).toBe(1);
  });

  test("auto hands the configured timeout to the probe", async () => {
    let seen: number | undefined;
    await openSqliteStore(
      join(scratchDir(), "t.db"),
      migrations,
      opts({ probeTimeoutMs: 750, probe: async (_p, t) => ((seen = t), { ok: true, reason: "ok", ms: 0 }) }),
    );
    expect(seen).toBe(750);
  });

  test("auto by default runs the real probe on a file store — and this machine's tmp is WAL-capable", async () => {
    const dir = scratchDir();
    const store = await openSqliteStore(join(dir, "t.db"), migrations);
    expect(await journalMode(store)).toBe("wal");
    expect(readdirSync(dir).filter((n) => n.startsWith(".wal-probe"))).toEqual([]);
  });

  test("journalMode: wal skips the probe entirely", async () => {
    lines.length = 0;
    let called = false;
    const store = await openSqliteStore(join(scratchDir(), "t.db"), migrations, opts({ journalMode: "wal", probe: async () => ((called = true), { ok: false, reason: "x", ms: 0 }) }));
    expect(called).toBe(false);
    expect(await journalMode(store)).toBe("wal");
    expect(lines).toEqual(["trace-node: journal_mode=wal (JOURNAL_MODE set, probe skipped)"]);
  });

  test("journalMode: delete never sets WAL, and converts a file an earlier WAL host left behind", async () => {
    const path = join(scratchDir(), "t.db");
    // A previous, WAL-capable host: mark the file WAL and let go of it (a
    // Store has no close(); a raw handle does, and the mode is persistent in
    // the file header — which is exactly the situation a moved corpus is in).
    const earlier = new Database(path);
    expect((earlier.query("PRAGMA journal_mode = WAL").get() as { journal_mode: string }).journal_mode).toBe("wal");
    earlier.exec("CREATE TABLE left_behind (x)");
    earlier.close();
    expect(existsSync(path)).toBe(true);

    let called = false;
    const second = await openSqliteStore(path, migrations, { journalMode: "delete", probe: async () => ((called = true), { ok: true, reason: "x", ms: 0 }) });
    expect(called).toBe(false);
    expect(await journalMode(second)).toBe("delete");
  });

  test(":memory: never probes and still answers `memory`", async () => {
    lines.length = 0;
    let called = false;
    const store = await openSqliteStore(":memory:", migrations, opts({ probe: async () => ((called = true), { ok: false, reason: "x", ms: 0 }) }));
    expect(called).toBe(false);
    expect(await journalMode(store)).toBe("memory");
    expect(lines).toEqual([]);
  });

  test("parseJournalMode accepts the three values, any case, and nothing else", () => {
    expect(parseJournalMode("auto")).toBe("auto");
    expect(parseJournalMode(" WAL ")).toBe("wal");
    expect(parseJournalMode("Delete")).toBe("delete");
    expect(parseJournalMode("")).toBeUndefined();
    expect(parseJournalMode(undefined)).toBeUndefined();
    expect(parseJournalMode("truncate")).toBeUndefined();
  });
});
