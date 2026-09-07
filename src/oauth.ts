/**
 * A minimal OAuth 2.1 authorization server — exactly enough for an MCP client.
 *
 * This exists for ONE client: claude.ai. A remote MCP connector cannot send a
 * static header, so no amount of bearer-token support reaches it; OAuth is the
 * only door it knows how to walk through. Everything here is in service of that,
 * and the shape is inherited from a version already running in production
 * elsewhere in this fleet (arra-memory-haos/src/oauth.ts).
 *
 * What is implemented, and why each piece is not optional:
 *
 *   Dynamic Client Registration (RFC 7591)  claude.ai registers itself. There is
 *                                           no screen anywhere to paste a
 *                                           client_id into.
 *   Authorization Code + PKCE S256          `plain` is refused outright rather
 *   (RFC 7636)                              than accepted and ignored — OAuth
 *                                           2.1 drops it and advertising it
 *                                           invites a client to use it.
 *   AS metadata (RFC 8414)                  how a client finds the endpoints.
 *   Protected resource metadata (RFC 9728)  how a client gets from a 401 on
 *                                           /mcp to the authorization server.
 *
 * Deliberately absent: refresh tokens, client secrets, accounts, per-scope
 * consent. One owner, one passphrase, one corpus. A public client cannot keep a
 * secret anyway, which is the whole reason PKCE exists.
 *
 * Storage is the D1 database that is already bound — migrations 0003 and 0004.
 * Codes and tokens are stored as SHA-256 DIGESTS, never in the clear: the token
 * is the secret, so a row holding one is as sensitive as the session it opens,
 * and any read of this database — a console, a backup, an injection elsewhere —
 * would otherwise hand over directly replayable credentials.
 *
 * The Cloudflare-native answer would be @cloudflare/workers-oauth-provider over
 * a KV namespace, and it was not taken. KV does auto-provision, so "one more
 * binding" is the weaker half of the argument; the disqualifying half is that
 * the library inverts the entry point — OAuthProvider becomes the default export
 * and the Elysia app becomes its `defaultHandler` — which destroys the property
 * this whole codebase is built on: that `createApp({ store })` is a pure
 * function of a Store, and therefore runs identically under `bun test`, under
 * D1, and later under Tauri.
 */

import { OAUTH } from "./sql";
import type { Store } from "./store/types";
import { fromTrustedProxy, nowIso, nowSeconds, randomToken, sha256Base64Url, type Clock } from "./utils";

/** One round trip, not a session. */
const CODE_TTL_SECONDS = 10 * 60;
/** 30 days. No refresh token: reconnecting is one click and rotation nobody
 *  audits is worse than an expiry everybody can see. */
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Every scope this server knows. `traces:read` is the first ENFORCED one (PRD
 * §3.10): offered on the consent page as an unchecked checkbox, listed in
 * `scopes_supported`, never advertised in the 401 challenge.
 */
export const SCOPES = ["nodes:read", "nodes:write", "traces:read"] as const;
/** What a client gets by default, and what the 401 tells it to ask for. */
export const DEFAULT_SCOPES = ["nodes:read", "nodes:write"] as const;
export const DEFAULT_SCOPE = DEFAULT_SCOPES.join(" ");
export const TRACES_READ = "traces:read";

/**
 * Hosts a client may register a redirect on (PRD §3.9 #5). digger accepted any
 * https host, so one link — a registration naming `https://evil/cb` and an
 * /authorize URL the owner is tricked into approving — minted the attacker a
 * 30-day token. Loopback is always allowed for Claude Code and local clients.
 */
export const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com", "anthropic.com"] as const;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_BYTES = 2048;
const MAX_CLIENT_NAME = 120;

export const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/** `claude.ai` allows `claude.ai` and `api.claude.ai`, never `notclaude.ai`. */
export function isAllowedRedirectHost(hostname: string, hosts: readonly string[]): boolean {
  if (isLoopbackHost(hostname)) return true;
  const host = hostname.toLowerCase();
  return hosts.some((allowed) => {
    const a = allowed.trim().toLowerCase();
    return a !== "" && (host === a || host.endsWith(`.${a}`));
  });
}

/** An RFC 7591 refusal with its error code, so the endpoint can name it. */
export class RegistrationError extends Error {
  constructor(
    public readonly code: "invalid_client_metadata" | "invalid_redirect_uri",
    message: string,
  ) {
    super(message);
  }
}

export interface RegisteredClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  createdAt?: string;
}

export interface TokenInfo {
  token: string;
  clientId: string;
  scope: string;
  resource: string | null;
}

// ── discovery ────────────────────────────────────────────────────────────────

/**
 * RFC 8414. `issuer` MUST equal the origin the client actually reached, byte for
 * byte.
 *
 * This is the single most expensive mistake available in this file. A client
 * compares the issuer in this document against the URL it fetched it from, and a
 * mismatch — a trailing slash, http vs https, the workers.dev host when a custom
 * domain was used — fails the whole flow with no useful error anywhere. It is
 * also invisible to any static-token test, because the static path keeps working
 * throughout. Hence `originOf` deriving it from the live request, and PUBLIC_URL
 * as an explicit override for deployments behind a proxy that rewrites Host.
 */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    /**
     * S256 only — and this field's PRESENCE is load-bearing, not just its
     * value. It is OPTIONAL in RFC 8414, but MCP tightens it: a client that
     * finds it absent must conclude the server has no PKCE and refuse to start
     * the flow at all. Omitting it breaks a server that fully supports S256.
     */
    code_challenge_methods_supported: ["S256"],
    // A public client authenticates with PKCE, not a secret.
    token_endpoint_auth_methods_supported: ["none"],
    // RFC 9207: this server returns `iss` on the authorization redirect, and
    // says so here — a client cannot check what it was not told to expect.
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [...SCOPES],
  };
}

/** RFC 9728. `resource` is the MCP endpoint itself, not the origin. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
  };
}

/**
 * The origin to advertise. PUBLIC_URL wins when set; otherwise it is derived
 * from the request, honouring the forwarding headers ONLY when the socket peer
 * is a trusted proxy (PRD §3.9 #2) — a forged `x-forwarded-host` would
 * otherwise put an attacker's host into `issuer`.
 */
export function originOf(request: Request, publicUrl?: string, trustedProxies: readonly string[] = []): string {
  if (publicUrl?.trim()) return publicUrl.trim().replace(/\/+$/, "");
  const url = new URL(request.url);
  const trusted = fromTrustedProxy(request, trustedProxies);
  const proto = (trusted ? request.headers.get("x-forwarded-proto") : null) ?? url.protocol.replace(":", "");
  const host =
    (trusted ? request.headers.get("x-forwarded-host") : null) ?? request.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}

// ── dynamic client registration ──────────────────────────────────────────────

export async function registerClient(
  store: Store,
  input: { client_name?: string; redirect_uris?: string[] },
  options: { redirectHosts?: readonly string[]; clock?: Clock } = {},
): Promise<RegisteredClient> {
  const invalid = (message: string) => new RegistrationError("invalid_client_metadata", message);
  const raw = input.redirect_uris;
  if (raw !== undefined && !Array.isArray(raw)) throw invalid("redirect_uris must be an array");
  const redirectUris = (raw ?? []).filter((uri) => typeof uri === "string" && uri.length > 0);
  if (redirectUris.length === 0) throw invalid("redirect_uris is required");
  // Bounded (PRD §3.9 #5): registration is open, so its inputs are the one
  // thing an anonymous caller gets to store here.
  if (redirectUris.length > MAX_REDIRECT_URIS) throw invalid(`at most ${MAX_REDIRECT_URIS} redirect_uris`);

  // Registration is open — anyone who can reach the server can register a
  // client. That is what the spec asks of a server offering DCR, and it is not
  // the whole security boundary: registering gets you an unusable client_id,
  // and /authorize requires the owner passphrase before any code is issued.
  // But the consent page is only as honest as the host it names, so the host
  // itself is policed (PRD §3.9 #5; RFC 7591 permits policy refusal).
  const hosts = options.redirectHosts ?? DEFAULT_REDIRECT_HOSTS;
  for (const uri of redirectUris) {
    if (new TextEncoder().encode(uri).length > MAX_REDIRECT_URI_BYTES) throw invalid("redirect_uri too long");
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw invalid(`redirect_uri is not a URL: ${uri}`);
    }
    // http is allowed ONLY on loopback, which is how a local MCP client running
    // on the user's own machine completes the flow. Anything else on the open
    // internet must be https or the code travels in clear text.
    const loopback = isLoopbackHost(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      throw invalid(`redirect_uri must be https (or http on loopback): ${uri}`);
    }
    // A fragment in a redirect_uri is forbidden by RFC 6749 §3.1.2 and would be
    // silently dropped by the browser on redirect.
    if (parsed.hash) throw invalid(`redirect_uri must not contain a fragment: ${uri}`);
    if (!isAllowedRedirectHost(parsed.hostname, hosts)) {
      throw new RegistrationError(
        "invalid_redirect_uri",
        `redirect_uri host is not allowed here: ${parsed.hostname} (allowed: ${hosts.join(", ")}, loopback)`,
      );
    }
  }

  let clientName: string | null = null;
  if (input.client_name !== undefined && input.client_name !== null) {
    if (typeof input.client_name !== "string") throw invalid("client_name must be a string");
    // Printable characters only: the consent page prints this name.
    if (/[\u0000-\u001F\u007F]/.test(input.client_name)) throw invalid("client_name must be printable");
    clientName = input.client_name.slice(0, MAX_CLIENT_NAME);
  }

  const clientId = randomToken(16);
  const createdAt = nowIso(options.clock);

  await store.run(OAUTH.clients.register, [clientId, clientName, JSON.stringify(redirectUris), createdAt]);

  return { clientId, clientName, redirectUris, createdAt };
}

export async function getClient(store: Store, clientId: string): Promise<RegisteredClient | null> {
  if (!clientId) return null;
  const row = await store.first<{
    client_id: string;
    client_name: string | null;
    redirect_uris: string;
    created_at: string;
  }>(OAUTH.clients.byId, [clientId]);
  if (!row) return null;

  let redirectUris: string[] = [];
  try {
    const parsed = JSON.parse(row.redirect_uris);
    if (Array.isArray(parsed)) redirectUris = parsed.filter((u) => typeof u === "string");
  } catch {
    redirectUris = [];
  }
  return { clientId: row.client_id, clientName: row.client_name, redirectUris, createdAt: row.created_at };
}

/**
 * Exact match, always.
 *
 * Prefix matching is the classic OAuth open redirect: a client registered for
 * `https://x.com/cb` must not be able to receive a code at
 * `https://x.com/cb.attacker.net` or `https://x.com/cb/../elsewhere`.
 */
export function isRegisteredRedirect(client: RegisteredClient, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}

// ── authorization code ───────────────────────────────────────────────────────

export async function issueCode(
  store: Store,
  input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string;
    resource?: string | null;
  },
): Promise<string> {
  if (input.codeChallengeMethod !== "S256") throw new Error("code_challenge_method must be S256");
  if (!input.codeChallenge) throw new Error("code_challenge is required");

  const code = randomToken(32);
  // The DIGEST is stored; the code itself is returned and never persisted.
  await store.run(OAUTH.codes.issue, [
    await sha256Base64Url(code),
    input.clientId,
    input.redirectUri,
    input.codeChallenge,
    input.codeChallengeMethod,
    input.scope,
    input.resource ?? null,
    nowSeconds() + CODE_TTL_SECONDS,
  ]);
  return code;
}

/**
 * Exchange a code for a token.
 *
 * The code is deleted before any check runs, whatever the outcome. An
 * authorization code is single-use and a FAILED exchange must burn it too —
 * otherwise an attacker holding an intercepted code gets unlimited attempts at
 * guessing the verifier, which is exactly what PKCE is there to prevent.
 */
export async function exchangeCode(
  store: Store,
  input: { code: string; clientId: string; redirectUri: string; codeVerifier: string },
): Promise<{ accessToken: string; scope: string; expiresIn: number }> {
  // Hash first: every lookup and delete below addresses the row by digest,
  // because that is the only form of the code this database ever holds.
  const codeHash = await sha256Base64Url(input.code);
  const row = await store.first<{
    code_hash: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    scope: string;
    resource: string | null;
  }>(OAUTH.codes.consume, [codeHash, nowSeconds()]);

  if (!row) throw new Error("invalid_grant");
  await store.run(OAUTH.codes.delete, [codeHash]);

  // The code was issued to ONE client for ONE redirect_uri. Both must match, or
  // a different client could redeem a code it merely observed.
  if (row.client_id !== input.clientId) throw new Error("invalid_grant");
  if (row.redirect_uri !== input.redirectUri) throw new Error("invalid_grant");

  // PKCE: only the party that made the request knows the verifier whose SHA-256
  // is the stored challenge.
  const computed = await sha256Base64Url(input.codeVerifier);
  if (computed !== row.code_challenge) throw new Error("invalid_grant");

  const accessToken = randomToken(32);
  await store.run(OAUTH.tokens.issue, [
    await sha256Base64Url(accessToken),
    row.client_id,
    row.scope,
    row.resource,
    nowIso(),
    nowSeconds() + TOKEN_TTL_SECONDS,
  ]);

  return { accessToken, scope: row.scope, expiresIn: TOKEN_TTL_SECONDS };
}

// ── bearer verification ──────────────────────────────────────────────────────

/**
 * Verify a presented bearer token.
 *
 * `expectedResource`, when given, enforces the RFC 8707 audience: a token
 * recorded for one resource must not open another. The policy is fail-OPEN on
 * absence and CLOSED on mismatch — a NULL `resource` is accepted because not
 * every client sends the parameter, and refusing those would lock out clients
 * that are behaving legally. A non-NULL one that disagrees is refused, because
 * at that point the client told us what the token was for and this is not it.
 */
export async function verifyBearer(
  store: Store,
  token: string,
  expectedResource?: string,
): Promise<TokenInfo | null> {
  if (!token) return null;
  const row = await store.first<{
    token_hash: string;
    client_id: string;
    scope: string;
    resource: string | null;
  }>(OAUTH.tokens.verify, [await sha256Base64Url(token), nowSeconds()]);
  if (!row) return null;

  if (expectedResource && row.resource && row.resource !== expectedResource) return null;

  return {
    token: row.token_hash,
    clientId: row.client_id,
    scope: row.scope,
    resource: row.resource,
  };
}

export async function revokeToken(store: Store, token: string): Promise<void> {
  await store.run(OAUTH.tokens.revoke, [await sha256Base64Url(token)]);
}

/**
 * Revoke everything a client holds — live tokens and any code still in flight.
 *
 * The registration row deliberately survives: it is the record that this client
 * existed, and the next connect re-authorizes without re-registering. The effect
 * is immediate because verification reads the table on every request; there is
 * no cache to wait out.
 */
export async function revokeClient(store: Store, clientId: string): Promise<void> {
  await store.batch([
    { sql: OAUTH.tokens.revokeForClient, args: [clientId] },
    { sql: OAUTH.codes.deleteForClient, args: [clientId] },
  ]);
}

/**
 * Revoke EVERY client's tokens and in-flight codes at once — `DELETE
 * /api/clients`, the "Revoke all connectors" step of the post-exposure
 * procedure (PRD §3.3, §3.10 d, §6.5). Rotating the passphrase does not
 * touch a 30-day token (`changing the lock keeps OAuth tokens`), so this is
 * the one call that does. Registrations survive exactly as `revokeClient`
 * leaves them: each connector re-authorizes on its next connect without
 * re-registering. Returns what went, so the caller can say so.
 */
export async function revokeAllClients(store: Store): Promise<{ tokens: number; codes: number; clients: number }> {
  const clients = Number(
    (await store.first<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_clients"))?.n ?? 0,
  );
  const [tokens, codes] = await store.batch([
    { sql: OAUTH.tokens.revokeAll },
    { sql: OAUTH.codes.deleteAll },
  ]);
  return { tokens: tokens?.changes ?? 0, codes: codes?.changes ?? 0, clients };
}

/** Housekeeping: drop codes and tokens already past their deadline. Returns
 *  what went, so the janitor (PRD §3.8) can report it. */
export async function sweepExpired(store: Store): Promise<{ codes: number; tokens: number }> {
  const now = nowSeconds();
  const [codes, tokens] = await store.batch([
    { sql: OAUTH.codes.sweep, args: [now] },
    { sql: OAUTH.tokens.sweep, args: [now] },
  ]);
  return { codes: codes?.changes ?? 0, tokens: tokens?.changes ?? 0 };
}

/**
 * Who has ever connected, and what is live right now. `authorized` (PRD §3.7,
 * 1b-4) is computed, never stored: a client is authorized while it holds at
 * least one unexpired token, and stops being so the moment the last one is
 * revoked or expires — the flag the Access panel shows beside each name.
 */
export async function listClients(store: Store): Promise<
  Array<{
    client_id: string;
    client_name: string | null;
    created_at: string;
    active_tokens: number;
    last_token_at: string | null;
    authorized: boolean;
  }>
> {
  const rows = await store.all<Record<string, unknown>>(OAUTH.clients.list, [nowSeconds()]);
  return rows.map((row) => {
    const active = Number(row.active_tokens ?? 0);
    return {
      client_id: String(row.client_id),
      client_name: row.client_name ? String(row.client_name) : null,
      created_at: String(row.created_at),
      active_tokens: active,
      last_token_at: row.last_token_at ? String(row.last_token_at) : null,
      authorized: active > 0,
    };
  });
}
