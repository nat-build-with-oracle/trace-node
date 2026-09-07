/**
 * The WAL probe, child half. Run by wal-probe.ts in a separate process:
 *
 *     bun src/store/wal-probe-child.ts /data/.wal-probe-1234.sqlite
 *
 * It opens that scratch file, switches it to WAL, writes a row, reads it back,
 * checkpoints, and exits 0. Every one of those steps is one that hung forever
 * on kvmlab1 (trace-node#1) — so this MUST be a separate process: a
 * `bun:sqlite` call blocks the thread, and a hung thread cannot observe its
 * own timeout. The parent kills this process if it does not return in time.
 *
 * Exit codes: 0 ok; 2 WAL was requested but SQLite answered another mode;
 * 1 anything threw. The parent treats everything non-zero the same way.
 */

import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("wal-probe-child: expected a scratch file path");
  process.exit(1);
}

const cleanup = () => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      unlinkSync(file + suffix);
    } catch {
      /* not there — fine */
    }
  }
};

try {
  const db = new Database(file);
  const mode = (db.query("PRAGMA journal_mode = WAL").get() as { journal_mode: string }).journal_mode;
  if (mode.toLowerCase() !== "wal") {
    db.close();
    cleanup();
    process.exit(2);
  }
  db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
  db.exec("INSERT INTO probe (v) VALUES ('wal')");
  const row = db.query("SELECT v FROM probe").get() as { v: string } | null;
  if (row?.v !== "wal") throw new Error(`read back ${JSON.stringify(row)}`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  cleanup();
  process.exit(0);
} catch (error) {
  console.error(`wal-probe-child: ${error instanceof Error ? error.message : String(error)}`);
  cleanup();
  process.exit(1);
}
