/**
 * The browser's key.
 *
 * OAuth serves claude.ai and a static bearer serves curl, but neither serves the
 * web page this Worker already ships: a browser cannot hold a bearer token
 * without script keeping it somewhere an XSS could read, and asking the owner to
 * paste a token into every tab is not a design.
 *
 * So the page gets a cookie. It carries no data and identifies nobody — it is a
 * signed expiry and nothing else. Possession of a validly-signed one proves the
 * holder knew the owner passphrase at some point in the last 30 days, which is
 * exactly the claim being made, and the signature means the server keeps no
 * session table to grow, sweep, or leak.
 *
 * The key is the owner passphrase itself, so changing the passphrase invalidates
 * every outstanding session for free.
 */

import { base64UrlEncode } from "./utils";

export const SESSION_COOKIE_NAME = "trace_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

async function sign(passphrase: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(mac));
}

/** `<expiry seconds>.<hmac>` — everything needed to verify, nothing else. */
export async function issueSession(passphrase: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = String(expires);
  return `${payload}.${await sign(passphrase, payload)}`;
}

export async function verifySession(
  passphrase: string | undefined,
  token: string | null,
): Promise<boolean> {
  if (!passphrase || !token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;

  const payload = token.slice(0, dot);
  const presented = token.slice(dot + 1);

  const expires = Number(payload);
  if (!Number.isFinite(expires) || expires <= Math.floor(Date.now() / 1000)) return false;

  // Compare the two MACs, not the two tokens. Both sides are fixed-length
  // base64 of a digest here, so a plain loop over them leaks nothing about the
  // passphrase — but it still must not short-circuit.
  const expected = await sign(passphrase, payload);
  if (expected.length !== presented.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

/**
 * `Secure` is derived from THIS request's scheme, not from whether a public
 * HTTPS URL is configured.
 *
 * Conflating those silently breaks login: the browser refuses to store a Secure
 * cookie over plain http, so a correct passphrase returns 200, no cookie is
 * kept, and the UI stays on the lock screen — which reads to the user as "wrong
 * password". Measured elsewhere in this fleet, not theorised.
 */
/**
 * `path` is the ingress prefix when the login came through Home Assistant's
 * iframe (PRD §3.9 #7). digger set `Path=/` always, so a cookie minted inside
 * the iframe was stored on HA's origin and sent to Home Assistant and to every
 * other add-on's ingress path — a co-resident add-on could read it. Scoped to
 * `/api/hassio_ingress/<token>` it reaches only this add-on.
 */
export function sessionCookie(token: string, secure: boolean, path = "/"): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    `Path=${path || "/"}`,
    "HttpOnly",
    // Lax, not Strict: the OAuth flow returns to this origin via a redirect from
    // the client, and Strict would drop the cookie on that navigation.
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearedSessionCookie(secure: boolean, path = "/"): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    `Path=${path || "/"}`,
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
