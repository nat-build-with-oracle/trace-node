/**
 * One gate, three keys — and an honest fourth state where the gate is open.
 *
 * Different callers can prove themselves in different ways, and no single
 * mechanism serves them all:
 *
 *   oauth          claude.ai connectors. They cannot send a static header at
 *                  all, so OAuth is the only door open to them. This is the
 *                  entire reason oauth.ts exists.
 *   api-token      curl, scripts, Claude Code, a Tauri client — anything that
 *                  reads a config file and CAN send a static header, and for
 *                  which the OAuth dance would be ceremony with no benefit.
 *   owner-session  the web page. A browser has cookies and cannot hold a bearer
 *                  token without script keeping it somewhere readable.
 *   open           nothing configured. Documented below, and reported by
 *                  /health on every call rather than left to be inferred.
 *
 * All keys open the same corpus with the same rights. The distinction is how the
 * caller proved it is the owner, not what it may then do — scopes are recorded
 * on the token because the spec asks for them, and are deliberately not enforced
 * as a permission split. One owner does not need to be protected from itself,
 * and a permission system nobody exercises is a bug farm, not a boundary.
 */

import { DEFAULT_SCOPES, verifyBearer } from "./oauth";
import { SESSION_COOKIE_NAME, verifySession } from "./session";
import type { Store } from "./store/types";
import { fromIngress, parseCidrs, readCookie, timingSafeEqual, type IngressCheck } from "./utils";

export type AuthMethod = "open" | "owner-session" | "api-token" | "oauth" | "ingress";

export interface AuthConfig {
  /** Enables OAuth and the web login. Without it there is no way to approve a
   *  client, so the OAuth endpoints refuse rather than pretend. */
  ownerPassphrase?: string;
  /** Enables a static bearer for scripts and local MCP clients. */
  apiToken?: string;
  /**
   * Accept Home Assistant's own session in place of the passphrase, for
   * requests that genuinely arrived through ingress.
   *
   * OFF unless the operator turns it on. When on, opening the sidebar panel
   * signs you in — Home Assistant already asked who you are, and asking again
   * one iframe deeper is a password prompt guarding a door that is already
   * locked.
   *
   * It never widens the mapped port: see fromIngress() for why the source
   * address does the work the header cannot.
   */
  ingressAutoLogin?: boolean;
  /**
   * The ONE address ingress requests come from — Home Assistant on the hassio
   * bridge, `172.30.32.2` by default. Never a range (PRD §3.9 #6).
   */
  ingressPeer?: string;
  /**
   * HA user ids admitted through ingress (`auto_login_ha_user_ids`). Empty
   * (the default) with `ingressAutoLoginHaAdmins` off admits any
   * HA-authenticated user and records `ha_user` — what the sidebar does today
   * (PRD §3.9 #6, §8.2). Anyone else gets the 403 deny page (§8.1b).
   */
  ingressAutoLoginHaUserIds?: string[];
  /**
   * `auto_login_ha_admins`: also admit HA admins, as Core reports them over
   * the Supervisor websocket (`isHaAdmin`). OFF by default. When on, an empty
   * id list no longer means "anyone" — the operator asked for a role check,
   * so only listed ids and admins get in; that is the stricter of the two
   * readings of PRD §8.1b "decided v0.4.1" and is recorded in the 1b-3 commit.
   */
  ingressAutoLoginHaAdmins?: boolean;
  /**
   * The admin lookup — `adminChecker(() => readAdminIds(...))` from
   * ha-admin.ts in server.ts, a fake in tests. Consulted only when
   * `ingressAutoLoginHaAdmins` is on AND the id is not listed. Absent (no
   * `SUPERVISOR_TOKEN`), throwing, or answering "no" all DENY: fail closed.
   */
  isHaAdmin?: (id: string) => Promise<boolean>;
  /**
   * Peers whose forwarded headers (`cf-connecting-ip`, `x-forwarded-*`) are
   * believed — CIDRs or addresses, default EMPTY (PRD §3.9 #2). Consulted by
   * the rate-limit key, the ledger's remote_ip, `originOf` and the ingress
   * check (a trusted proxy can never be the ingress peer).
   */
  trustedProxies?: string[];
  /**
   * Hosts a client may register an OAuth redirect on; loopback is always
   * allowed. Default `claude.ai, claude.com, anthropic.com` (PRD §3.9 #5).
   */
  oauthRedirectHosts?: string[];
}

export interface AuthResult {
  ok: boolean;
  method?: AuthMethod;
  clientId?: string;
  scope?: string;
  /** Ingress only: `X-Remote-User-Id`, read AFTER the peer check (PRD §3.9 #6). */
  haUser?: string;
  /**
   * `ok: false` with this set: the request DID come through ingress and DID
   * name an HA user, but that user is neither listed nor (with admins on) an
   * admin. The gate answers with the 403 deny page naming the id and the
   * option to paste it into — not the 401 that starts the OAuth dance, which
   * would be a lie about what went wrong (PRD §8.1b).
   */
  ingressDenied?: IngressDenial;
}

/** What the deny page shows: the identity Supervisor forwarded, nothing minted. */
export interface IngressDenial {
  userId: string;
  userName: string;
}

/** The add-on option a denied id must be pasted into — named on the deny page. */
export const ALLOWLIST_OPTION = "auto_login_ha_user_ids";

/**
 * Who asked — built once per request by the gate and handed to every handler
 * and tool (PRD §3.1). `method`/`principal` are derived exactly as the
 * connections ledger derives them; `scope` is the OAuth token's granted scope
 * or `'*'` for owner-session / api-token; `client` is attacker-controlled and
 * never identity.
 */
export interface Caller {
  method: AuthMethod;
  principal: string;
  ha_user: string;
  client: string;
  scope: string;
}

/**
 * The callers who ARE the owner (PRD §3.10): a browser session unlocked with
 * the passphrase, the operator's static token, or anyone at all on an open
 * server — where there is no gate, there is nobody else. Never an OAuth
 * token (a connector, or whoever stole it) and never an ingress identity (an
 * admitted HA user is a reader, not the operator). The owner-only routes —
 * `GET /api/traces`, `DELETE /api/trace?q=`, `DELETE /api/clients` — all
 * ask this one question.
 */
export const OWNER_METHODS: ReadonlySet<AuthMethod> = new Set<AuthMethod>(["open", "owner-session", "api-token"]);
export const isOwnerCaller = (caller: Pick<Caller, "method">): boolean => OWNER_METHODS.has(caller.method);

const DENIED: AuthResult = { ok: false };
const OPEN: AuthResult = { ok: true, method: "open" };

/**
 * Whether this deployment has any credential at all.
 *
 * With neither secret set the server stays open — the same behaviour it had
 * before this file existed. That is a deliberate choice for a one-click install:
 * a deploy button that produces a Worker returning 401 to its own owner, with no
 * way to set a secret from the same screen, is a broken first run. The cost is
 * real and must not be hidden, so it is stated in /health, in the README, and on
 * the page itself.
 */
export function authEnabled(config: AuthConfig): boolean {
  return Boolean(config.ownerPassphrase?.trim() || config.apiToken?.trim());
}

/** What /health reports. Never the secrets — only which doors exist. */
export function authModes(config: AuthConfig): string[] {
  const modes: string[] = [];
  if (config.apiToken?.trim()) modes.push("api-token");
  if (config.ownerPassphrase?.trim()) modes.push("oauth", "owner-session");
  // Reported so /health answers "why am I already logged in?" without anyone
  // having to read the add-on options to find out.
  if (config.ingressAutoLogin) modes.push("ingress");
  return modes;
}

export async function authenticate(
  store: Store,
  request: Request,
  config: AuthConfig,
  /**
   * The RFC 8707 audience this request is being made against — for the MCP
   * endpoint, `<origin>/mcp`. Passed only where there is a resource to check
   * against; a token recorded for one resource must not open another.
   */
  expectedResource?: string,
  /** The key the session cookie is signed with. Folds in the STORED passphrase,
   *  so changing it from the UI invalidates every outstanding session. Falls
   *  back to the env secret when the caller has nothing better. */
  sessionKey?: string,
): Promise<AuthResult> {
  if (!authEnabled(config)) return OPEN;

  const authorization = request.headers.get("authorization");

  if (authorization) {
    // Scheme match is case-insensitive per RFC 7235; a client sending "bearer"
    // is compliant and must not be rejected as anonymous.
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (!match) return DENIED;
    const presented = match[1].trim();
    if (!presented) return DENIED;

    // Static token first: one comparison, against the OAuth path's database
    // round trip. Constant-time, because `===` on a secret leaks how much of it
    // was right.
    if (config.apiToken?.trim() && (await timingSafeEqual(presented, config.apiToken.trim()))) {
      return { ok: true, method: "api-token" };
    }

    if (config.ownerPassphrase?.trim()) {
      const token = await verifyBearer(store, presented, expectedResource);
      if (token) {
        return { ok: true, method: "oauth", clientId: token.clientId, scope: token.scope };
      }
    }

    // A Bearer header that matched neither is a definite no. Falling through to
    // the cookie here would let an expired token ride an open browser session
    // and report the wrong method in the call log.
    return DENIED;
  }

  const cookie = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
  if (await verifySession(sessionKey ?? config.ownerPassphrase, cookie)) {
    return { ok: true, method: "owner-session" };
  }

  // Last, and only when switched on. Last because a real credential should
  // always be preferred and should always be what the call log records; a
  // request that proved itself properly must not be filed as "ingress".
  if (config.ingressAutoLogin) {
    const ingress = fromIngress(request, config.ingressPeer, parseCidrs(config.trustedProxies));
    if (ingress.ok) return admitIngress(ingress, config);
  }

  return DENIED;
}

/**
 * Admission through ingress, in order (PRD §8.1b "decided v0.4.1"):
 *
 *   1. the request is proven to be ingress — done by the caller (fromIngress)
 *   2. `X-Remote-User-Id` is present. Supervisor omits it when it holds no
 *      session identity, so an absent id is "nobody signed in": a plain 401,
 *      not a deny page with an empty name on it — and on `GET /` a form-less
 *      401 page, never the lock screen (PRD §3.9 #7; auth-plugin.ts
 *      `INGRESS_REFUSALS`).
 *   3. the id is listed in `auto_login_ha_user_ids`, OR the list is empty and
 *      admins are off (PRD §3.9 #6: any HA-authenticated user), OR admins are
 *      on and Core says this id is an admin
 *   4. otherwise the deny page — 403, the id, the option name, no token.
 *
 * The lookup runs only when it can change the answer: a listed id never
 * costs a websocket round trip, and with admins off Core is never asked.
 */
async function admitIngress(ingress: IngressCheck, config: AuthConfig): Promise<AuthResult> {
  if (!ingress.haUser) return DENIED;
  const listed = config.ingressAutoLoginHaUserIds ?? [];
  const admins = Boolean(config.ingressAutoLoginHaAdmins);

  let admitted = listed.includes(ingress.haUser) || (listed.length === 0 && !admins);
  if (!admitted && admins) {
    try {
      admitted = config.isHaAdmin ? (await config.isHaAdmin(ingress.haUser)) === true : false;
    } catch {
      // An unreachable Core denies; it never admits (fail closed).
      admitted = false;
    }
  }
  if (admitted) return { ok: true, method: "ingress", haUser: ingress.haUser };
  return { ok: false, ingressDenied: { userId: ingress.haUser, userName: ingress.haUserName } };
}

/**
 * The 401 that starts the OAuth dance.
 *
 * `WWW-Authenticate` carries the RFC 9728 resource-metadata pointer an MCP
 * client follows to discover where /authorize lives. Without this header
 * claude.ai has no way to learn this server even has an authorization server,
 * and reports nothing more useful than a failed connection.
 *
 * The CORS headers are not decoration: the 401 is a cross-origin response like
 * any other, and a browser-side client that cannot READ the header learns
 * nothing from receiving it.
 */
export function unauthorized(origin: string, description = "Missing or invalid access token"): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", error_description: description }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        // The parameter order and set follow the canonical form in Claude's own
        // connector documentation. `scope` is included because a client is
        // entitled to learn what it should ASK for from the challenge itself,
        // rather than having to fetch the metadata document to find out.
        "www-authenticate":
          `Bearer realm="trace-node", ` +
          `error="invalid_token", ` +
          `error_description="${description}", ` +
          `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", ` +
          // `traces:read` is deliberately not advertised here — it is opt-in
          // on the consent page (PRD §3.10, §5 #3).
          `scope="${DEFAULT_SCOPES.join(" ")}"`,
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "www-authenticate",
      },
    },
  );
}
