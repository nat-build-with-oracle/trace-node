/**
 * Who is a Home Assistant admin — looked up, never trusted from a header.
 *
 * Supervisor injects `X-Remote-User-Id` / `-Name` through ingress, and nothing
 * else: there is no is-admin header (supervisor PR #4152 lists exactly three
 * identity headers; PRD §8.1b "decided v0.4.1", research/ha-admin-lookup.md).
 * So `auto_login_ha_admins` has to ask Core. With `homeassistant_api: true` the
 * add-on holds `SUPERVISOR_TOKEN`, opens `ws://supervisor/core/websocket`,
 * authenticates with that token and sends ONE read-only command,
 * `config/auth/list`. A user is an admin when
 *
 *     is_active && (is_owner || group_ids.includes("system-admin"))
 *
 * — the group id is the permission system's source of truth, a bare
 * `is_admin` field is deliberately not enough on its own. The answer is cached
 * for 60 s; a failed lookup answers "no admins" for 5 s and is retried. The
 * token never reaches the page and is never logged.
 *
 * Ported behaviour-for-behaviour from the p2p_dropbox add-on
 * (oracle-haos-factory `lab/02-p2p-dropbox-kvmlab1`
 * `10-p2p_dropbox/dropbox/ha-admin.ts`, commit 6b7dfd4, browser-proven deny
 * flow). Tested here against a fake in-process websocket server — no live
 * Supervisor is needed to prove the wire sequence.
 */

/** Core's websocket, as the Supervisor proxies it to an add-on. */
export const HA_CORE_WEBSOCKET = "ws://supervisor/core/websocket";

/** The bare shape of one `config/auth/list` entry this file reads. */
interface HaUser {
  id?: unknown;
  is_active?: unknown;
  is_owner?: unknown;
  group_ids?: unknown;
}

const isAdminUser = (u: HaUser): boolean =>
  typeof u.id === "string" &&
  u.is_active === true &&
  (u.is_owner === true || (Array.isArray(u.group_ids) && u.group_ids.includes("system-admin")));

/**
 * Read the ids of every active owner/admin from Core, once.
 *
 * Read-only: only `auth` and `config/auth/list` are ever sent; no user
 * management command exists in this file. Rejects — never resolves to an
 * empty set — when the token is blank, the socket errors or closes early, the
 * auth is refused, the answer is malformed, or `timeoutMs` passes; the caller
 * (`adminChecker`) turns every rejection into "nobody is an admin" for 5 s.
 */
export function readAdminIds(endpoint: string, token: string, timeoutMs = 3000): Promise<Set<string>> {
  if (!token) return Promise.reject(new Error("HA Core credentials unavailable"));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint);
    let done = false;
    const finish = (ids?: Set<string>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.close();
      if (ids) resolve(ids);
      else reject(new Error("HA admin lookup unavailable"));
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    ws.onerror = () => finish();
    ws.onclose = () => finish();
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
        else if (msg.type === "auth_ok") ws.send(JSON.stringify({ id: 1, type: "config/auth/list" }));
        else if (msg.type === "auth_invalid") finish();
        else if (msg.type === "result" && msg.id === 1) {
          if (!msg.success || !Array.isArray(msg.result)) return finish();
          finish(new Set((msg.result as HaUser[]).filter(isAdminUser).map((u) => u.id as string)));
        }
      } catch {
        finish();
      }
    };
  });
}

/** What the gate asks: "is this HA user id an admin right now?" */
export type HaAdminCheck = (id: string) => Promise<boolean>;

/**
 * A cached `isAdmin(id)` over one loader.
 *
 * Success is remembered for 60 s, failure for 5 s as an EMPTY set — a stale
 * grant is never kept past its minute, and an outage denies rather than
 * admits (fail closed). Concurrent callers during a refresh share one load.
 * `now` is injectable so the clock can be advanced in a test.
 */
export function adminChecker(load: () => Promise<Set<string>>, now: () => number = Date.now): HaAdminCheck {
  let ids = new Set<string>();
  let expires = 0;
  let pending: Promise<void> | undefined;
  return async (id: string): Promise<boolean> => {
    if (now() >= expires) {
      pending ??= load()
        .then((value) => {
          ids = value;
          expires = now() + 60_000;
        })
        .catch(() => {
          ids = new Set();
          expires = now() + 5000;
        })
        .finally(() => {
          pending = undefined;
        });
      await pending;
    }
    return ids.has(id);
  };
}
