/**
 * A guessing budget for the one credential a human chose — and, since
 * trace-node, for the ones a machine can try at wire speed.
 *
 * Every other secret in this server has real entropy — a 32-byte bearer token, a
 * PKCE verifier, an authorization code burned on the first failed exchange. The
 * owner passphrase is the exception, and `/login` and `/authorize` were willing
 * to be asked about it without limit. On a port reachable from a LAN or a mesh,
 * that turns a short passphrase from "weak" into "falls this afternoon".
 *
 * WHAT THIS IS NOT: a perimeter. It keys on the socket peer, so an attacker with
 * many addresses gets many budgets and a shared NAT gives many users one. It
 * converts an UNLIMITED online guessing attack into a limited one. A long
 * passphrase is still the real defence; this buys the time to have chosen one.
 *
 * THE KEY (PRD §3.9 #2): the socket peer server.ts stamped. digger keyed on
 * `cf-connecting-ip` first, which off Cloudflare is whatever the client sent —
 * a fresh header per request bought a fresh five-guess budget per request. A
 * forwarded header is believed only from a `trusted_proxies` peer.
 *
 * OPTIONAL, and off is a legitimate answer: behind Cloudflare Access, on a
 * private network, or with a 40-character passphrase, the budget buys nothing
 * and costs a write per failed attempt. `createApp({ rateLimit: false })`, or
 * the `RATE_LIMIT=off` var. It defaults ON whenever auth is on, because the
 * deployment that most needs it is the one nobody configured.
 */

import { RATE } from "./sql";
import type { Store } from "./store/types";
import { forwardedClient, nowSeconds, peerOf } from "./utils";

/** Quiet for this long and the record is forgotten — an old typo costs nothing. */
const WINDOW_SECONDS = 15 * 60;

const MAX_LOCKOUT_SECONDS = 60 * 60;

/**
 * Buckets, and the free attempts each allows before backoff (PRD §3.9 #2, #5, #11).
 *
 *   login / authorize   5 — room for a fat-fingered owner, nowhere near a dictionary
 *   bearer              50 bad Bearer tokens per 15 min per peer, then 429
 *   register            10 client registrations per 15 min per peer
 *   dig                 60 digs per 10 min per method:principal (step 4)
 */
export const FREE_ATTEMPTS = { login: 5, authorize: 5, bearer: 50, register: 10, dig: 60 } as const;

export type RateBucket = keyof typeof FREE_ATTEMPTS;

/**
 * How long to wait after `failures` wrong guesses.
 *
 *   5 → 2m     7 →  8m      9 → 32m
 *   6 → 4m     8 → 16m     10+ → 60m (capped)
 *
 * Five free, then roughly a dozen guesses a day — against the hundreds of
 * thousands per second an unthrottled endpoint allows. The cap means a mistake
 * is always recoverable by waiting rather than by redeploying. The other
 * buckets follow the same curve from their own free count.
 */
export function lockoutSeconds(failures: number, bucket: RateBucket = "login"): number {
  const free = FREE_ATTEMPTS[bucket];
  if (failures < free) return 0;
  const doublings = Math.min(failures - free + 1, 20);
  return Math.min(2 ** doublings * 60, MAX_LOCKOUT_SECONDS);
}

/**
 * The bucket key: the socket peer, or what a TRUSTED proxy says the client was.
 *
 * Under `bun test` there is no stamped peer and everything shares one bucket:
 * correct for a single-owner dev box, and what lets the tests exercise this.
 */
export const clientIp = (request: Request, trustedProxies: readonly string[] = []): string =>
  forwardedClient(request, trustedProxies) ?? peerOf(request) ?? "local";

/**
 * Seconds the caller must wait, or 0 if they may try now.
 *
 * FAILS OPEN. If the store errors the attempt proceeds, which is the behaviour
 * that existed before this file — bad, but no worse than yesterday. Failing
 * closed would let a transient database fault lock the owner out of their own
 * corpus with no way back in, since the only way to fix it is through the door
 * that just shut. Stated here rather than discovered at 3am.
 */
export async function retryAfter(store: Store, bucket: RateBucket, ip: string): Promise<number> {
  let row: { failures: number; last_at: number } | null = null;
  try {
    row = await store.first(RATE.get, [bucket, ip]);
  } catch {
    return 0;
  }
  if (!row) return 0;

  const elapsed = nowSeconds() - row.last_at;
  if (elapsed > WINDOW_SECONDS) return 0; // stale; the next failure resets it
  return Math.max(0, lockoutSeconds(row.failures, bucket) - elapsed);
}

/** Count one wrong guess. Best-effort: a store error must not turn a failed
 *  login into a 500, which would be a louder oracle than the 401 itself. */
export async function recordFailure(store: Store, bucket: RateBucket, ip: string): Promise<void> {
  const now = nowSeconds();
  try {
    await store.run(RATE.fail, [bucket, ip, now, now - WINDOW_SECONDS, now]);
  } catch {
    /* fail open — see retryAfter */
  }
}

/** A correct passphrase wipes the slate for that caller. */
export async function recordSuccess(store: Store, bucket: RateBucket, ip: string): Promise<void> {
  try {
    await store.run(RATE.clear, [bucket, ip]);
  } catch {
    /* best effort */
  }
}

/** The 429. `Retry-After` is in seconds, per RFC 9110. */
export const tooManyAttempts = (seconds: number, html: string): Response =>
  new Response(html, {
    status: 429,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "retry-after": String(seconds),
      "access-control-allow-origin": "*",
    },
  });

/** The same 429 for an API caller, as JSON. */
export const tooManyAttemptsJson = (seconds: number, error = "too_many_attempts"): Response =>
  new Response(JSON.stringify({ error, retry_after: seconds }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(seconds),
      "access-control-allow-origin": "*",
    },
  });

// ── the denied-request log (PRD §3.9 #11) ────────────────────────────────────
//
// digger recorded successes only; nobody could see a credential being guessed.
// One line per denied request, rate-limited to one per second per peer so a
// flood cannot fill the log faster than it fills the bucket.

const lastDeniedLog = new Map<string, number>();

export function logDenied(entry: { method: string; path: string; peer: string; reason: string }): void {
  const now = Math.floor(Date.now() / 1000);
  if (lastDeniedLog.get(entry.peer) === now) return;
  lastDeniedLog.set(entry.peer, now);
  // Bounded: forget peers that have not been seen for a while.
  if (lastDeniedLog.size > 10_000) {
    for (const [peer, at] of lastDeniedLog) if (now - at > 60) lastDeniedLog.delete(peer);
  }
  console.warn(`trace-node: denied ${JSON.stringify(entry)}`);
}
