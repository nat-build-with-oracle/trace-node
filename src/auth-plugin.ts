/**
 * Authentication as one Elysia plugin: the gate, the OAuth endpoints, and the
 * browser's login, mounted with a single `.use()`.
 *
 * Why a plugin rather than routes inlined in app.ts:
 *
 *   - The endpoints and the gate that protects everything else cannot be
 *     mounted separately. Half of this feature — discovery documents and a
 *     token endpoint with nothing actually guarded — is worse than none, and
 *     a plugin makes that combination impossible to assemble by accident.
 *   - app.ts stays about the corpus. Twelve OAuth routes in the middle of the
 *     content API is how the one file anyone reads to understand the product
 *     stops being readable.
 *   - It is portable. The Tauri build that store/sqlite.ts exists for gets the
 *     same auth by using the same plugin, with no copied code to drift.
 *
 * THE SCOPE TRAP, stated up front because it is the one that bites:
 * an Elysia lifecycle hook registered inside a plugin is LOCAL by default — it
 * runs for routes declared in the plugin and NOT for routes in the parent that
 * mounted it. A gate with default scope would therefore protect the OAuth
 * endpoints (which need no protection) and leave /mcp and /api/* wide open,
 * silently, with every test that only exercises the plugin still passing. Hence
 * `{ as: "global" }` below, and hence `test/auth.test.ts` asserting that a
 * PARENT route 401s — the assertion exists to catch this exact regression, not
 * to restate the obvious.
 */

import { Elysia } from "elysia";

import {
  ALLOWLIST_OPTION,
  authenticate,
  authEnabled,
  isOwnerCaller,
  unauthorized,
  type AuthConfig,
  type AuthResult,
  type Caller,
  type IngressDenial,
} from "./auth";
import * as oauth from "./oauth";
import { checkOwner, clearPassphrase, MIN_PASSPHRASE, readStored, setPassphrase } from "./passphrase";
import { countable, principalOf, record, uaFamily } from "./connections";
import {
  clientIp,
  logDenied,
  recordFailure,
  recordSuccess,
  retryAfter,
  tooManyAttempts,
  tooManyAttemptsJson,
  type RateBucket,
} from "./ratelimit";
import { approvalPage, denyPage, ingressRefusedPage, loginPage } from "./screens";
import { clearedSessionCookie, issueSession, sessionCookie } from "./session";
import type { Store } from "./store/types";
import { ingressBase, parseCidrs, remoteAddress, timingSafeEqual, type Clock } from "./utils";

export interface AuthPluginOptions {
  store: Store;
  auth?: AuthConfig;
  /** Throttle the passphrase endpoints. Defaults ON whenever auth is on — the
   *  deployment that most needs a guessing budget is the one nobody
   *  configured. See ratelimit.ts for when turning it off is reasonable. */
  rateLimit?: boolean;
  /** Overrides the origin advertised in OAuth metadata. Only needed behind a
   *  proxy that rewrites Host — see oauth.ts on why this must be exact. */
  publicUrl?: string;
  instanceName?: string;
  /** The app clock (PRD §3.2). */
  clock?: Clock;
}

/**
 * What the gate learned, published to handlers (PRD §3.1).
 *
 * One module-level map. Elysia hands the same Request object to hooks and
 * handlers, so the gate can publish what it learned without changing the
 * handler signatures. If that object identity ever breaks, the fallback is
 * `.resolve({ as: "global" })` returning `{ auth }` — same data, different
 * transport.
 */
const AUTH = new WeakMap<Request, AuthResult>();
const CALLER = new WeakMap<Request, Caller>();
export const authOf = (request: Request): AuthResult | undefined => AUTH.get(request);
export const callerOf = (request: Request): Caller | undefined => CALLER.get(request);

const OPEN_RESULT: AuthResult = { ok: true, method: "open" };
/**
 * The caller for a handler, always: what the gate published, or — on an open
 * server, where the gate returns before it learns anything — the `open`
 * caller built from the same request, so `client` is still the UA family.
 */
export const callerFor = (request: Request): Caller => CALLER.get(request) ?? buildCaller(OPEN_RESULT, request);

/** The caller object, derived exactly as the connections ledger derives it. */
export function buildCaller(result: AuthResult, request: Request): Caller {
  const method = result.method ?? "open";
  return {
    method,
    principal: method === "open" ? "" : principalOf(method, result.clientId, request),
    ha_user: result.haUser ?? "",
    client: uaFamily(request.headers.get("user-agent")).slice(0, 120),
    scope: method === "oauth" ? (result.scope ?? "") : "*",
  };
}

/**
 * Paths that must answer before a caller has any credential.
 *
 * An allow-list, not a deny-list: a route added later is protected by default,
 * and forgetting to list one costs a 401 rather than an open door. Each entry
 * earns its place —
 *
 *   /health                 an operator must be able to see the server is up,
 *                           and its body carries no corpus content.
 *   /.well-known/*          the discovery documents, fetched BEFORE a client
 *                           has a token. Protecting them would make the OAuth
 *                           flow undiscoverable — a 401 pointing at a 401.
 *   /oauth/register|token   the flow itself, protected by its own logic (PKCE,
 *                           single-use codes) rather than by this gate.
 *   /authorize              carries the owner passphrase in its own POST body.
 *   /login, /logout         the browser's way in and out.
 *   /                       serves the lock screen rather than a bare 401,
 *                           which a browser renders as a blank page.
 */
const PUBLIC_PATHS = new Set([
  "/health",
  "/oauth/register",
  "/oauth/token",
  "/authorize",
  "/login",
  "/logout",
  "/",
]);

export const isPublicPath = (pathname: string): boolean =>
  PUBLIC_PATHS.has(pathname) || pathname.startsWith("/.well-known/");

/**
 * The 403 deny page (PRD §8.1b): the request came through ingress and named an
 * HA user the options do not admit. JSON when the caller asked for JSON, the
 * HTML page otherwise; the same four fields either way. `no-store` because
 * the body names a person and the answer changes the moment the option is
 * edited. No cookie, no token — nothing here is a credential.
 */
export function ingressDeniedResponse(request: Request, denial: IngressDenial, instanceName: string): Response {
  const body = { ok: false, user_id: denial.userId, user_name: denial.userName, allowlistOption: ALLOWLIST_OPTION };
  const wantsJson = /\bjson\b/i.test(request.headers.get("accept") ?? "");
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "content-type": wantsJson ? "application/json" : "text/html; charset=utf-8",
  };
  return new Response(
    wantsJson
      ? JSON.stringify(body)
      : denyPage({ instanceName, userId: denial.userId, userName: denial.userName, allowlistOption: ALLOWLIST_OPTION }),
    { status: 403, headers },
  );
}

/**
 * Why a request that came through the ingress iframe with auto-login on was
 * not admitted — and got NO passphrase form (PRD §3.9 #7). 1b-3 fix ruling:
 *
 *   NO_USER_ID   ingress proven, `X-Remote-User-Id` absent or malformed —
 *                Supervisor omits it when nobody is signed in to HA
 *   NOT_INGRESS  `X-Ingress-Path` present but the peer or the path shape did
 *                not prove ingress — the header alone is a claim (utils.ts)
 *   NO_FORM      `POST /login` through ingress — the form is not offered
 *                there, so a POST to it is refused before any passphrase is
 *                looked at
 *
 * The first two are 401 (nobody is signed in); the last is 403 (a thing that
 * exists elsewhere is refused here). The descriptions are the p2p_dropbox
 * add-on's wording, the prior art for the no-id case.
 */
export const INGRESS_REFUSALS = {
  NO_USER_ID: { status: 401, message: "Home Assistant ingress did not provide a user id" },
  NOT_INGRESS: { status: 401, message: "Home Assistant ingress required" },
  NO_FORM: { status: 403, message: "The passphrase form is not offered through Home Assistant ingress" },
} as const;

/**
 * The form-less refusal through ingress with auto-login on. JSON when the
 * caller asked for JSON (the gate's own `unauthorized` shape, minus the OAuth
 * challenge — a browser iframe is not an MCP client), the `ingressRefusedPage`
 * otherwise. `no-store`; never a cookie, never a form.
 */
export function ingressRefusedResponse(
  request: Request,
  refusal: (typeof INGRESS_REFUSALS)[keyof typeof INGRESS_REFUSALS],
  instanceName: string,
): Response {
  const wantsJson = /\bjson\b/i.test(request.headers.get("accept") ?? "");
  return new Response(
    wantsJson
      ? JSON.stringify({ error: refusal.status === 401 ? "unauthorized" : "forbidden", error_description: refusal.message })
      : ingressRefusedPage({ instanceName, message: refusal.message }),
    {
      status: refusal.status,
      headers: {
        "cache-control": "no-store",
        "content-type": wantsJson ? "application/json" : "text/html; charset=utf-8",
      },
    },
  );
}

/** The header the page sends on every request (PRD §3.10 c). */
export const CSRF_HEADER = "x-trace-client";
export const CSRF_VALUE = "ui";
const isMutating = (method: string): boolean => !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());

/**
 * Whether THIS request arrived over TLS — not whether a public HTTPS URL is
 * configured.
 *
 * Conflating those silently breaks login: the browser refuses to store a
 * `Secure` cookie over plain http, so a correct passphrase returns 302, no
 * cookie is kept, and the next page is the lock screen again — which reads to
 * the user as "wrong password" while the logs show a successful login.
 */
const isSecureRequest = (request: Request): boolean =>
  new URL(request.url).protocol === "https:" ||
  request.headers.get("x-forwarded-proto") === "https";

export function authPlugin({
  store,
  auth = {},
  publicUrl,
  instanceName = "trace-node",
  rateLimit,
  clock,
}: AuthPluginOptions) {
  const guarded = authEnabled(auth);
  const throttled = rateLimit ?? guarded;
  const trusted = parseCidrs(auth.trustedProxies);
  /** The bucket key and the ledger address, both keyed on the peer (PRD §3.9 #2). */
  const peer = (request: Request) => clientIp(request, trusted);
  const address = (request: Request) => remoteAddress(request, trusted);

  /**
   * The key the session cookie is signed with.
   *
   * It folds in the STORED passphrase hash, not just the env secret, so that
   * changing the passphrase from the UI invalidates every outstanding session —
   * on every device. Signing with the env secret alone would mean "change the
   * lock" left the old keys working, which is the opposite of what the button
   * says it does.
   */
  const sessionKey = async () => {
    const stored = await readStored(store);
    return (auth.ownerPassphrase ?? "") + "\u0000" + (stored ?? "");
  };

  /** 0 when the caller may try. One branch, so "is throttling on?" is answered
   *  in one place rather than at each call site. */
  const wait = (request: Request, bucket: RateBucket) =>
    throttled ? retryAfter(store, bucket, peer(request)) : Promise.resolve(0);
  const origin = (request: Request) => oauth.originOf(request, publicUrl, trusted);

  /** Where the session cookie lives: the ingress prefix inside HA, else the root (PRD §3.9 #7). */
  const cookiePath = (request: Request) => ingressBase(request) || "/";

  /** The requested scope minus `traces:read`, which only the checkbox grants. */
  const baseScope = (asked: string): string => {
    const scopes = asked.split(/\s+/).filter((s) => s && s !== oauth.TRACES_READ);
    return scopes.length ? scopes.join(" ") : oauth.DEFAULT_SCOPE;
  };
  /** What the consent page states about a client (PRD §3.9 #5). */
  const consentFacts = (client: oauth.RegisteredClient, redirectUri: string) => {
    let redirectHost = "?";
    try {
      redirectHost = new URL(redirectUri).host;
    } catch {
      /* the caller already refused an unparseable redirect */
    }
    return {
      clientName: client.clientName ?? client.clientId,
      redirectHost,
      clientId: client.clientId,
      registeredAt: client.createdAt ?? null,
    };
  };

  /** Why a request was refused — for the log line, never for the response. */
  const denialReason = (request: Request): string => {
    if (request.headers.has("authorization")) return "bearer";
    if (request.headers.has("cookie")) return "cookie";
    if (request.headers.has("x-ingress-path")) return "ingress";
    return "none";
  };

  // A `name` makes this plugin deduplicated by Elysia: mounting it twice
  // registers one copy of the hook rather than running the gate twice.
  return (
    new Elysia({ name: "trace-auth", aot: false })

      /**
       * The gate. `as: "global"` is load-bearing — see the scope trap above.
       *
       * One hook rather than a wrapper per route: a route that forgets to
       * authenticate is the bug this cannot afford, and an allow-list checked
       * in one place is auditable in a way twenty decorated handlers are not.
       *
       * With no secrets configured this returns immediately and the server
       * behaves exactly as it did before auth existed.
       */
      .onBeforeHandle({ as: "global" }, async ({ request }) => {
        if (!guarded) return;
        if (request.method === "OPTIONS") return;
        const { pathname } = new URL(request.url);
        if (isPublicPath(pathname)) return;

        // Bad Bearer tokens are throttled per peer (PRD §3.9 #11): a short
        // operator-chosen api_token was otherwise guessable at wire speed.
        // Checked BEFORE the comparison, like the passphrase doors.
        const presentsBearer = request.headers.has("authorization");
        if (presentsBearer) {
          const held = await wait(request, "bearer");
          if (held > 0) {
            logDenied({ method: request.method, path: pathname, peer: peer(request), reason: "bearer_throttled" });
            return tooManyAttemptsJson(held);
          }
        }

        // The audience a token must have been issued for, when it carries one.
        const result = await authenticate(store, request, auth, `${origin(request)}/mcp`, await sessionKey());
        // Returning a Response short-circuits the route. It carries its own
        // CORS headers because onAfterHandle does not run on this path, and a
        // 401 a browser cannot read teaches a client nothing — this particular
        // 401 is the first step of the OAuth flow.
        if (!result.ok) {
          if (presentsBearer && throttled) await recordFailure(store, "bearer", peer(request));
          // A proven ingress request naming an unadmitted HA user is not
          // "no credential" — it is "this person, not on the list". The deny
          // page says so; a 401 here would start an OAuth dance that cannot
          // help them. The id is not logged: the log line is per peer.
          if (result.ingressDenied) {
            logDenied({ method: request.method, path: pathname, peer: peer(request), reason: "ingress_denied" });
            return ingressDeniedResponse(request, result.ingressDenied, instanceName);
          }
          logDenied({ method: request.method, path: pathname, peer: peer(request), reason: denialReason(request) });
          return unauthorized(origin(request));
        }

        // The CSRF rule (PRD §3.10 c). A cookie or an ingress identity rides
        // along with any request the browser makes, including one a
        // cross-origin form on the same HA origin submits. Every mutating
        // /api/* route reached that way must carry `X-Trace-Client: ui` — a
        // header a cross-site form cannot set. Bearer callers are exempt: a
        // Bearer header cannot be forged cross-site.
        if (
          (result.method === "owner-session" || result.method === "ingress") &&
          isMutating(request.method) &&
          pathname.startsWith("/api/") &&
          request.headers.get(CSRF_HEADER) !== CSRF_VALUE
        ) {
          logDenied({ method: request.method, path: pathname, peer: peer(request), reason: "csrf" });
          return Response.json(
            { error: "forbidden", message: `Send ${CSRF_HEADER}: ${CSRF_VALUE} with a cookie or ingress session.` },
            { status: 403, headers: { "access-control-allow-origin": "*" } },
          );
        }

        // Publish what the gate learned to the handlers (PRD §3.1).
        AUTH.set(request, result);
        CALLER.set(request, buildCaller(result, request));

        // Fold the caller into the ledger. Awaited rather than fired and
        // forgotten: a floating promise here would drop counts under load.
        // record() swallows its own errors, so this cannot fail a request that
        // the gate has already allowed.
        if (countable(pathname)) {
          await record(store, result, request, address(request), {}, clock);
        }
      })

      // ── discovery ──────────────────────────────────────────────────────────
      // Served unconditionally, even with OAuth switched off. A client that
      // fetches these on an open server learns the endpoints exist and then
      // gets a 200 from /mcp without a token, which is the truth. Hiding them
      // when unconfigured would make "is OAuth available here?" unanswerable.
      .get("/.well-known/oauth-authorization-server", ({ request }) =>
        oauth.authorizationServerMetadata(origin(request)),
      )
      /**
       * The OIDC alias for the same document.
       *
       * Not because this is an OpenID provider — it is not. A spec-compliant
       * MCP client that gets a 404 from the RFC 8414 path is required to try
       * this one next, and a client that reaches it and 404s again stops. It is
       * the identical body at a second URL: the cheapest possible insurance
       * against a discovery chain that dead-ends.
       */
      .get("/.well-known/openid-configuration", ({ request }) =>
        oauth.authorizationServerMetadata(origin(request)),
      )
      /**
       * RFC 9728 locates a protected resource's metadata by appending the
       * resource's PATH to the well-known prefix. For an MCP endpoint at /mcp
       * that is /.well-known/oauth-protected-resource/mcp — the bare path is
       * the form for a resource at the origin root. Both are served: the
       * suffixed one because it is correct, the bare one because clients ask
       * for it anyway.
       */
      .get("/.well-known/oauth-protected-resource", ({ request }) =>
        oauth.protectedResourceMetadata(origin(request)),
      )
      .get("/.well-known/oauth-protected-resource/mcp", ({ request }) =>
        oauth.protectedResourceMetadata(origin(request)),
      )

      // ── dynamic client registration ────────────────────────────────────────
      .post("/oauth/register", async ({ body, request, set }) => {
        // Registration responses carry a client_id: never cached (PRD §3.9 #4).
        set.headers["cache-control"] = "no-store";
        if (!auth.ownerPassphrase?.trim()) {
          // 501, not 404: the endpoint exists and is unconfigured, which is a
          // different problem for whoever is debugging it than a wrong URL.
          set.status = 501;
          return {
            error: "oauth_not_configured",
            error_description: "Set the OWNER_PASSPHRASE secret to enable OAuth.",
          };
        }
        // 10 registrations / 15 min per socket peer (PRD §3.9 #5). Counted
        // whatever the outcome — the budget is on asking, not on failing.
        const held = await wait(request, "register");
        if (held > 0) return tooManyAttemptsJson(held);
        if (throttled) await recordFailure(store, "register", peer(request));
        try {
          const client = await oauth.registerClient(
            store,
            (body ?? {}) as { client_name?: string; redirect_uris?: string[] },
            { redirectHosts: auth.oauthRedirectHosts ?? oauth.DEFAULT_REDIRECT_HOSTS, clock },
          );
          set.status = 201;
          return {
            client_id: client.clientId,
            client_name: client.clientName,
            redirect_uris: client.redirectUris,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code"],
            response_types: ["code"],
          };
        } catch (error) {
          set.status = 400;
          return {
            error: error instanceof oauth.RegistrationError ? error.code : "invalid_client_metadata",
            error_description: error instanceof Error ? error.message : "invalid",
          };
        }
      })

      // ── the approval page ──────────────────────────────────────────────────
      .get("/authorize", async ({ query, request }) => {
        if (!auth.ownerPassphrase?.trim()) {
          return new Response("OAuth is not configured on this deployment.", {
            status: 501,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }

        const clientId = String(query.client_id ?? "");
        const redirectUri = String(query.redirect_uri ?? "");
        const client = await oauth.getClient(store, clientId);

        // Never redirect on an unknown client or an unregistered redirect_uri.
        // Redirecting here IS the open redirect that the exact-match check
        // exists to prevent, so the failure stays on our own page.
        if (!client || !oauth.isRegisteredRedirect(client, redirectUri)) {
          return new Response("Unknown client or unregistered redirect_uri.", {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }

        return new Response(
          approvalPage({
            base: ingressBase(request),
            ...consentFacts(client, redirectUri),
            params: {
              client_id: clientId,
              redirect_uri: redirectUri,
              state: String(query.state ?? ""),
              code_challenge: String(query.code_challenge ?? ""),
              code_challenge_method: String(query.code_challenge_method ?? ""),
              scope: baseScope(String(query.scope ?? "")),
              resource: String(query.resource ?? `${origin(request)}/mcp`),
            },
          }),
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      })

      .post("/authorize", async ({ body, request }) => {
        const form = (body ?? {}) as Record<string, unknown>;
        const field = (name: string) => String(form[name] ?? "");

        if (!auth.ownerPassphrase?.trim()) {
          return new Response("OAuth is not configured on this deployment.", { status: 501 });
        }

        const clientId = field("client_id");
        const redirectUri = field("redirect_uri");
        const client = await oauth.getClient(store, clientId);
        if (!client || !oauth.isRegisteredRedirect(client, redirectUri)) {
          return new Response("Unknown client or unregistered redirect_uri.", { status: 400 });
        }

        const params = {
          client_id: clientId,
          redirect_uri: redirectUri,
          state: field("state"),
          code_challenge: field("code_challenge"),
          code_challenge_method: field("code_challenge_method"),
          scope: baseScope(field("scope")),
          resource: field("resource"),
        };
        // `traces:read` is granted only by the checkbox the owner ticked, never
        // by the scope the client asked for (PRD §3.10).
        const granted = field("traces_read") ? `${params.scope} ${oauth.TRACES_READ}` : params.scope;

        // Throttle BEFORE the comparison. Checking afterwards would still let
        // an attacker learn "wrong" at full speed, which is the only signal
        // they need — and would leak "right" to a locked-out caller.
        const ip = peer(request);
        const held = await wait(request, "authorize");
        if (held > 0) {
          return tooManyAttempts(
            held,
            approvalPage({
              base: ingressBase(request),
              ...consentFacts(client, redirectUri),
              error: `Too many failed attempts. Try again in ${held}s.`,
              params,
            }),
          );
        }

        if (!(await checkOwner(store, field("passphrase"), auth.ownerPassphrase))) {
          if (throttled) await recordFailure(store, "authorize", ip);
          return new Response(
            approvalPage({
              base: ingressBase(request),
              ...consentFacts(client, redirectUri),
              error: "That passphrase does not match. Try again.",
              params,
            }),
            { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        // A correct passphrase clears the record: an owner who mistypes twice
        // and then succeeds must not carry those failures forward.
        if (throttled) await recordSuccess(store, "authorize", ip);

        try {
          const code = await oauth.issueCode(store, {
            clientId,
            redirectUri,
            codeChallenge: params.code_challenge,
            codeChallengeMethod: params.code_challenge_method,
            scope: granted,
            resource: params.resource || null,
          });
          const target = new URL(redirectUri);
          target.searchParams.set("code", code);
          // `state` is the client's CSRF defence. Dropping it fails the flow at
          // the client, with an error that points nowhere near this server.
          if (params.state) target.searchParams.set("state", params.state);
          // RFC 9207. Lets a client that talks to several authorization servers
          // prove WHICH one answered, closing the mix-up attack where a code
          // from a malicious AS is redeemed at an honest one. Byte-identical to
          // the `issuer` in the metadata, because the client compares them
          // without normalising.
          target.searchParams.set("iss", origin(request));
          return new Response(null, { status: 302, headers: { location: target.toString() } });
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "Authorization failed.", {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      })

      // ── token exchange ─────────────────────────────────────────────────────
      .post("/oauth/token", async ({ body, set }) => {
        const form = (body ?? {}) as Record<string, unknown>;
        const field = (name: string) => String(form[name] ?? "");
        // RFC 6749 §5.1: a response carrying a token is never cached (PRD §3.9 #4).
        set.headers["cache-control"] = "no-store";

        if (field("grant_type") !== "authorization_code") {
          set.status = 400;
          return { error: "unsupported_grant_type" };
        }
        try {
          const result = await oauth.exchangeCode(store, {
            code: field("code"),
            clientId: field("client_id"),
            redirectUri: field("redirect_uri"),
            codeVerifier: field("code_verifier"),
          });
          // digger defined sweepExpired and never called it (PRD §3.9 #4). A
          // successful exchange is a rare, natural moment to drop what has
          // expired; the janitor (step 3) schedules it as well. Best-effort.
          await oauth.sweepExpired(store).catch(() => {});
          return {
            access_token: result.accessToken,
            token_type: "Bearer",
            expires_in: result.expiresIn,
            scope: result.scope,
          };
        } catch {
          // One opaque error for every failure mode. Naming which check failed
          // hands an attacker a probing oracle.
          set.status = 400;
          return { error: "invalid_grant" };
        }
      })

      // ── the browser's session ──────────────────────────────────────────────
      .get("/login", ({ query, request }) => {
        const base = ingressBase(request);
        // A bare "/" here would leave the ingress iframe and land on Home
        // Assistant's own dashboard, which looks like the add-on crashed.
        if (!guarded) return new Response(null, { status: 302, headers: { location: `${base}/` } });
        // Through ingress with auto-login on, Home Assistant already asked who
        // you are; the passphrase form is not offered there at all (PRD §3.9 #7).
        if (auth.ingressAutoLogin && base) return new Response(null, { status: 302, headers: { location: `${base}/` } });
        return new Response(
          loginPage({ instanceName, base, next: query.next ? String(query.next) : undefined }),
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      })

      .post("/login", async ({ body, request }) => {
        // Through ingress with auto-login on there is no form to have posted
        // from (PRD §3.9 #7): refused before the passphrase is looked at, so a
        // cookie can never be minted on Home Assistant's origin this way and
        // nothing here is a guessing oracle. Same condition GET /login uses.
        if (auth.ingressAutoLogin && ingressBase(request)) {
          return ingressRefusedResponse(request, INGRESS_REFUSALS.NO_FORM, instanceName);
        }
        const form = (body ?? {}) as Record<string, unknown>;
        const next = String(form.next ?? "/") || "/";

        const ip = peer(request);
        const held = await wait(request, "login");
        if (held > 0) {
          return tooManyAttempts(
            held,
            loginPage({ instanceName, base: ingressBase(request), error: `Too many failed attempts. Try again in ${held}s.` }),
          );
        }

        if (
          !auth.ownerPassphrase?.trim() ||
          !(await checkOwner(store, String(form.passphrase ?? ""), auth.ownerPassphrase))
        ) {
          if (throttled) await recordFailure(store, "login", ip);
          return new Response(loginPage({ instanceName, base: ingressBase(request), error: "That passphrase does not match." }), {
            status: 401,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (throttled) await recordSuccess(store, "login", ip);

        return new Response(null, {
          status: 302,
          headers: {
            // Same-origin paths only. An attacker-supplied `next` of
            // `https://evil/` — or the protocol-relative `//evil/`, which a
            // naive startsWith("/") check accepts — would otherwise turn a
            // successful login into an open redirect.
            location: next.startsWith("/") && !next.startsWith("//") ? next : "/",
            "set-cookie": sessionCookie(
              await issueSession(await sessionKey()),
              isSecureRequest(request),
              cookiePath(request),
            ),
          },
        });
      })

      .post("/logout", ({ request }) => {
        const base = ingressBase(request);
        return new Response(null, {
          status: 302,
          headers: {
            location: `${base}/`,
            "set-cookie": clearedSessionCookie(isSecureRequest(request), cookiePath(request)),
          },
        });
      })

      /**
       * Change the lock.
       *
       * The current passphrase is OPTIONAL when the caller already holds a valid
       * owner session, and required otherwise.
       *
       * The stricter version re-asked always, on the reasoning that a live
       * session proves someone got in once rather than that they are the owner
       * now. That is true, and on a single-owner lab it is friction for a modest
       * risk — the threat it stops is someone using your already-unlocked browser,
       * which is a threat physical access mostly wins anyway. What is NOT
       * optional is holding a session: an anonymous caller still cannot change
       * the lock, because the gate rejects them before this handler runs.
       */
      .post("/api/passphrase", async ({ body, request, set }) => {
        const form = (body ?? {}) as Record<string, unknown>;
        const current = String(form.current ?? "");
        const next = String(form.next ?? "").trim();

        if (!auth.ownerPassphrase?.trim()) {
          set.status = 501;
          return { error: "not_configured", message: "Set OWNER_PASSPHRASE before changing it." };
        }
        // A session already proved ownership; only verify `current` if it was
        // supplied, so a wrong one is still caught rather than ignored.
        if (current && !(await checkOwner(store, current, auth.ownerPassphrase))) {
          set.status = 401;
          return { error: "wrong_passphrase", message: "That is not the current passphrase." };
        }
        if (next.length < MIN_PASSPHRASE) {
          set.status = 400;
          return { error: "too_short", message: `Use at least ${MIN_PASSPHRASE} characters.` };
        }

        await setPassphrase(store, next);
        // Re-issue THIS session against the new key, so changing the lock does
        // not sign the person who changed it out of their own browser.
        return new Response(
          JSON.stringify({ ok: true, message: "Passphrase changed. Other sessions were signed out." }),
          {
            headers: {
              "content-type": "application/json",
              "set-cookie": sessionCookie(await issueSession(await sessionKey()), isSecureRequest(request), cookiePath(request)),
            },
          },
        );
      })

      /** Back to the deployed secret — the recovery path, in one call. */
      .delete("/api/passphrase", async ({ request }) => {
        await clearPassphrase(store);
        return new Response(
          JSON.stringify({ ok: true, message: "Reverted to the deployed OWNER_PASSPHRASE." }),
          {
            headers: {
              "content-type": "application/json",
              "set-cookie": sessionCookie(await issueSession(await sessionKey()), isSecureRequest(request), cookiePath(request)),
            },
          },
        );
      })

      /** Is a passphrase stored, or are we on the deployed secret? Never the value. */
      .get("/api/passphrase", async () => ({
        stored: Boolean(await readStored(store)),
        min_length: MIN_PASSPHRASE,
      }))

      // ── who holds access ───────────────────────────────────────────────────
      // Behind the gate like any other /api route: this lists the clients that
      // can reach the corpus, which is not public information.
      .get("/api/clients", async () => ({ clients: await oauth.listClients(store) }))

      /**
       * Revoke every connector at once (PRD §3.3, §6.5; 1b-4) — the button
       * behind the post-exposure procedure, since rotating the passphrase
       * leaves every 30-day token working. Owner-session or api-token only:
       * a connector's own token must not be able to sign every OTHER
       * connector out, and an admitted HA user is not the operator. A cookie
       * caller also needs `X-Trace-Client: ui` (the gate's CSRF rule).
       * Registrations stay, as with `/:id`; `authorized` on the list flips
       * to false for each.
       */
      .delete("/api/clients", async ({ request, set }) => {
        if (!isOwnerCaller(callerFor(request))) {
          set.status = 403;
          return { error: "forbidden", message: "Revoking every connector is owner-session and api-token only." };
        }
        const gone = await oauth.revokeAllClients(store);
        return { revoked: "all", ...gone };
      })

      .delete("/api/clients/:id", async ({ params }) => {
        await oauth.revokeClient(store, params.id);
        return { revoked: params.id };
      })
  );
}
