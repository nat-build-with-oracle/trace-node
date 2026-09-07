/**
 * Is WAL safe on this volume? Ask a disposable process, with a deadline.
 *
 * trace-node#1: on kvmlab1 (a real amd64 VM, /data on the Supervisor's
 * volume) `PRAGMA journal_mode = WAL` never returned. No error, no crash, the
 * add-on sat at "starting on port 8112" forever, and Supervisor called it
 * started. WAL needs a memory-mapped `-shm` file for its lock table, and a
 * volume that cannot honour that mapping does not fail the pragma — it blocks
 * it. The same image ran instantly under qemu on m5, and upstream digger-node
 * (which never sets WAL) runs fine on the same box.
 *
 * A blocking `bun:sqlite` call cannot be timed out from inside its own thread,
 * so the probe runs wal-probe-child.ts in a child process against a scratch
 * file IN THE SAME DIRECTORY as the real database (the volume is what is under
 * test, not SQLite). If the child does not exit 0 within the deadline it is
 * killed and the answer is "no", with a reason the boot log can print.
 *
 * Cost when everything is fine: one bun process, ~50–100 ms, once per boot.
 */

import { unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WalProbeResult {
  ok: boolean;
  /** Human-readable, for the boot log: "ok in 42ms", "timed out after 3000ms", "exit 2". */
  reason: string;
  ms: number;
}

export interface WalProbeOptions {
  /** How long the child may take before it is killed. Default 3000. */
  timeoutMs?: number;
  /**
   * The argv to spawn. Default: bun running wal-probe-child.ts on a scratch
   * file next to `dbPath`. Tests inject `["sleep", "30"]` to simulate the hang.
   */
  command?: string[];
}

export const DEFAULT_WAL_PROBE_TIMEOUT_MS = 3000;

const CHILD = join(import.meta.dir, "wal-probe-child.ts");

/** The scratch file the probe writes: unique per process, next to the corpus. */
export function probeFileFor(dbPath: string): string {
  return join(dirname(dbPath), `.wal-probe-${process.pid}-${Date.now()}.sqlite`);
}

function removeScratch(file: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      unlinkSync(file + suffix);
    } catch {
      /* the child already removed it, or never created it */
    }
  }
}

export async function walProbe(dbPath: string, options: WalProbeOptions = {}): Promise<WalProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAL_PROBE_TIMEOUT_MS;
  const scratch = probeFileFor(dbPath);
  const command = options.command ?? [process.execPath, CHILD, scratch];
  const started = Date.now();

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
  } catch (error) {
    return { ok: false, reason: `could not spawn (${error instanceof Error ? error.message : String(error)})`, ms: 0 };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, timeoutMs);

  const code = await proc.exited;
  clearTimeout(timer);
  const ms = Date.now() - started;
  removeScratch(scratch);

  if (timedOut) return { ok: false, reason: `timed out after ${timeoutMs}ms`, ms };
  if (code === 0) return { ok: true, reason: `ok in ${ms}ms`, ms };
  const stderr = proc.stderr instanceof ReadableStream ? (await new Response(proc.stderr).text()).trim() : "";
  return { ok: false, reason: `exit ${code}${stderr ? ` (${stderr.split("\n")[0]})` : ""}`, ms };
}
