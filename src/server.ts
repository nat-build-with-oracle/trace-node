/**
 * The entry point: the app, on a SQLite file, on a port.
 *
 * `createApp` has never been told which runtime it is on; this is the one file
 * that knows about a SQLite file, a socket, and the environment. Between them
 * sits the `Store` port, which is the whole reason nothing else changes.
 *
 *   DB_PATH                    where the corpus lives          (default ./trace.db)
 *   PORT                       what to listen on               (default 8099)
 *   HOST                       bind address                    (default 0.0.0.0)
 *   INSTANCE_NAME              shown in the page header
 *   OWNER_PASSPHRASE           the owner's key; min 12 (§6.3)
 *   API_TOKEN                  static bearer for scripts; min 24 (§3.9 #11)
 *   REQUIRE_OWNER_PASSPHRASE   default true; false needs an API_TOKEN
 *   INGRESS_AUTO_LOGIN         accept HA's session through ingress
 *   INGRESS_AUTO_LOGIN_HA_USER_IDS  comma-separated allowlist; empty (admins off) = any HA user
 *   INGRESS_AUTO_LOGIN_HA_ADMINS    =1 also admits HA admins, looked up over the Supervisor
 *                              websocket with SUPERVISOR_TOKEN (needs homeassistant_api: true;
 *                              boot refuses it without the token — §6.3 rule 7)
 *   INGRESS_PEER               the ONE address ingress comes from (default 172.30.32.2)
 *   TRUSTED_PROXIES            CIDRs whose forwarded headers are believed (default empty)
 *   OAUTH_REDIRECT_HOSTS       hosts a client may register a redirect on
 *   PUBLIC_URL                 only behind a proxy that rewrites Host — see oauth.ts
 *   RATE_LIMIT                 off/false/0 to disable throttling
 *   TRACE_RETENTION_DAYS       raw traces kept this long (default 180; §3.8)
 *   CALLS_RETENTION_DAYS       mcp_calls kept this long (default 90; §3.8)
 *   ALLOW_OPEN                 =1 starts with no credential, OUTSIDE the add-on only
 *
 * Boot is fail-closed (PRD §6.3): every misconfiguration above is one log line
 * and exit 1 before the port is bound. No secret has a default anywhere.
 *
 * Deliberately absent: an embedder. A self-hosted node runs TEXT SEARCH ONLY
 * and /api/health says so rather than implying a vector index that does not
 * exist. Wiring a local embedder later is one argument to createApp.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { createApp } from "./app";
import { bootProblem } from "./boot";
import { adminChecker, HA_CORE_WEBSOCKET, readAdminIds } from "./ha-admin";
import { startJanitor } from "./janitor";
import { openSqliteStore } from "./store/sqlite";
import { FORWARDED_HEADERS, ipInCidrs, parseCidrs, PEER_IP_HEADER } from "./utils";
import { VERSION } from "./version";

const env = process.env;
const flag = (value: string | undefined) => ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// ── fail-closed boot, before anything is opened ──────────────────────────────
const problem = bootProblem(env);
if (problem) {
  console.error(problem);
  process.exit(1);
}

/**
 * Every migration, in filename order, read at startup.
 *
 * Sorted lexically because the names are zero-padded (`0001_`, `0002_`…) and
 * that is the order they must run in. Read from disk rather than imported so
 * adding a migration is dropping in a file.
 *
 * The FILENAME travels with the SQL because openSqliteStore keeps a ledger and
 * runs each migration at most once. That is not belt-and-braces: 0004 renames a
 * column, so applying it twice fails with `no such column: "code"` — which is
 * exactly what a restart did before the ledger existed. Fresh databases were
 * always fine, which is why nothing caught it until the second boot.
 */
function migrations(dir: string): Array<{ name: string; sql: string }> {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

const dbPath = env.DB_PATH ?? "./trace.db";
const migrationsDir = env.MIGRATIONS_DIR ?? join(import.meta.dir, "..", "migrations");

const files = migrations(migrationsDir);
const store = await openSqliteStore(dbPath, files);

// Rule 7 (§6.3, §6.4): the SQLite this bun bundles must answer the functions
// the cloud ranking relies on. Stated at boot rather than discovered on the
// first /api/cloud.
try {
  const smoke = await store.first<{ v: string; p: number; l: number }>(
    "SELECT sqlite_version() AS v, power(2,2) AS p, ln(1) AS l",
  );
  if (!smoke || Number(smoke.p) !== 4 || Number(smoke.l) !== 0) throw new Error(`unexpected answer ${JSON.stringify(smoke)}`);
} catch (error) {
  console.error(`trace-node: SQLite smoke test failed (${error instanceof Error ? error.message : String(error)}); refusing to start.`);
  process.exit(1);
}

const trustedProxies = parseCidrs(env.TRUSTED_PROXIES);
const days = (value: string | undefined): number | undefined => {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
};
const retention = { traceDays: days(env.TRACE_RETENTION_DAYS), callsDays: days(env.CALLS_RETENTION_DAYS) };

/**
 * The HA admin lookup (PRD §8.1b, ha-admin.ts): built only when the Supervisor
 * handed us a token, read lazily on the first request that needs it, cached
 * 60 s. The token is captured here and nowhere else — it is not on the app
 * config as a string, not in the log line, never in a response. The socket it
 * asks is the Supervisor's own and is not configurable (boot.ts).
 */
const supervisorToken = (env.SUPERVISOR_TOKEN ?? "").trim();
const isHaAdmin = supervisorToken ? adminChecker(() => readAdminIds(HA_CORE_WEBSOCKET, supervisorToken)) : undefined;
const haUserIds = list(env.INGRESS_AUTO_LOGIN_HA_USER_IDS);

const app = createApp({
  retention,
  store,
  instanceName: env.INSTANCE_NAME || "trace-node",
  // No embedder off the Worker. `null` is honest; /api/health reports
  // "embedder: null" and search falls back to FTS.
  embedder: null,
  auth: {
    ownerPassphrase: env.OWNER_PASSPHRASE,
    apiToken: env.API_TOKEN,
    // Off unless explicitly turned on. See fromIngress() in utils.ts for what
    // it does and does not prove.
    ingressAutoLogin: flag(env.INGRESS_AUTO_LOGIN),
    ingressAutoLoginHaUserIds: haUserIds,
    ingressAutoLoginHaAdmins: flag(env.INGRESS_AUTO_LOGIN_HA_ADMINS),
    isHaAdmin,
    ingressPeer: env.INGRESS_PEER?.trim() || undefined,
    trustedProxies,
    oauthRedirectHosts: env.OAUTH_REDIRECT_HOSTS?.trim() ? list(env.OAUTH_REDIRECT_HOSTS) : undefined,
  },
  publicUrl: env.PUBLIC_URL,
  rateLimit:
    env.RATE_LIMIT === undefined
      ? undefined
      : !["off", "false", "0", "no"].includes(env.RATE_LIMIT.trim().toLowerCase()),
});

const port = Number(env.PORT ?? 8099);
const hostname = env.HOST ?? "0.0.0.0";

// The janitor (PRD §3.8): at boot and every ten minutes, self-hosted only —
// this is the one entry point that knows it owns a file on a disk.
startJanitor(store, {
  traceRetentionDays: retention.traceDays,
  callsRetentionDays: retention.callsDays,
  dataDir: dbPath === ":memory:" ? undefined : dirname(resolve(dbPath)),
});

Bun.serve({
  port,
  hostname,
  // Bun answers 413 natively above this, before Elysia's onParse reads the
  // body (PRD §3.3). Non-/mcp JSON POSTs are capped tighter in app.ts.
  maxRequestBodySize: 4 * 1024 * 1024,
  fetch(request, server) {
    /**
     * Stamp the socket's address onto the request, and OVERWRITE whatever
     * arrived under that name.
     *
     * This is the only place `PEER_IP_HEADER` is ever written. Without the
     * overwrite the header would be an ordinary client-supplied string, and
     * `fromIngress()` — which trusts it to decide that Home Assistant is really
     * the one asking — would be reading input from the party it is checking.
     * Deleting first rather than only setting, because a request carrying two
     * headers of the same name is not a shape worth reasoning about.
     *
     * The forwarded headers are DELETED unless the peer is a trusted proxy
     * (PRD §3.9 #2): on a mapped port `cf-connecting-ip` is whatever the
     * client typed, and nothing downstream should ever see it.
     */
    const headers = new Headers(request.headers);
    headers.delete(PEER_IP_HEADER);
    const peer = server.requestIP(request)?.address ?? "";
    if (!(peer && ipInCidrs(peer, trustedProxies))) {
      for (const name of FORWARDED_HEADERS) headers.delete(name);
    }
    if (peer) headers.set(PEER_IP_HEADER, peer);
    return app.fetch(new Request(request, { headers }));
  },
});

// One line, and it reports STATE rather than echoing config: the driver and the
// migration count are what actually happened at startup. Never a secret.
console.log(
  `trace-node ${VERSION} listening on http://${hostname}:${port}  ` +
    `driver=${store.driver} db=${dbPath} migrations=${files.length} ` +
    `auth=${env.OWNER_PASSPHRASE || env.API_TOKEN ? "on" : "OPEN (ALLOW_OPEN)"} ` +
    `auto_login=${flag(env.INGRESS_AUTO_LOGIN) ? "on" : "off"} ` +
    `auto_login_ha_admins=${flag(env.INGRESS_AUTO_LOGIN_HA_ADMINS) ? "on" : "off"} ids=${haUserIds.length} ` +
    `trusted_proxies=${trustedProxies.length} public_url=${env.PUBLIC_URL?.trim() ? "set" : "blank"}`,
);
