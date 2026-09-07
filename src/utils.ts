/**
 * The small shared things. No database, no HTTP, no imports from the rest of
 * the app — so anything here can be tested on its own and reused by a client.
 */

/**
 * One clock, threaded from createApp (PRD §3.2). Every `at` column and every
 * window comparison reads it, so a test can freeze or advance time in one place
 * instead of racing the wall clock.
 */
export type Clock = () => Date;

export const nowIso = (clock?: Clock): string => (clock ? clock() : new Date()).toISOString();

/** Epoch seconds. What every OAuth expiry is compared against. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * A readable, URL-safe id with the type baked into the prefix.
 * Time first so ids sort roughly by creation even outside the database.
 */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${prefix}_${time}${rand}`;
}

/**
 * A machine name: lowercase, dashes, nothing exotic.
 * Thai codepoints are kept deliberately — a Thai vocabulary name should survive
 * being slugified, and stripping them would silently produce an empty string.
 */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9฀-๿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Clamp a caller-supplied limit into a range the database is happy to serve. */
export const clampLimit = (value: unknown, fallback: number, max: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
};

export const clampOffset = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

/**
 * Truncate for storage, with the original length preserved in the marker.
 * Truncating at WRITE time is deliberate: a 100KB argument blob would otherwise
 * live in the database forever and only be trimmed when someone reads it.
 */
export function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…[${text.length} chars]` : text;
}

export function escapeHtml(input: string): string {
  return String(input).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

/**
 * Quote a search needle as an FTS5 phrase.
 * Doubling embedded quotes is the escape FTS5 defines; without it a needle
 * containing a quote is a syntax error, and one containing OR/NEAR is an
 * operator the user did not ask for.
 */
export const ftsPhrase = (query: string): string => `"${query.replace(/"/g, '""')}"`;

// ── credentials ──────────────────────────────────────────────────────────────
//
// Four small primitives, all on WebCrypto, which exists identically in workerd,
// Bun and the browser. Nothing here imports Node's `crypto`: that would build
// fine and then fail on the first request in the Worker.

/** base64url, unpadded — the encoding OAuth and PKCE both specify. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A URL-safe random secret. 32 bytes is the floor for anything bearer-shaped. */
export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** RFC 7636 S256: the verifier's SHA-256, base64url, unpadded. */
export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Constant-time string comparison, by comparing digests rather than characters.
 *
 * `a === b` on a secret leaks how much of it was right: the comparison exits at
 * the first differing byte, and the timing difference is measurable across a
 * network given enough samples. Hashing both sides first makes every comparison
 * take the same time regardless of input, and the fixed-length loop below never
 * short-circuits.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const viewA = new Uint8Array(digestA);
  const viewB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < viewA.length; i++) diff |= viewA[i] ^ viewB[i];
  return diff === 0;
}

/** One cookie out of a Cookie header, or null. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

/**
 * The URL prefix this request arrived under, or "" for a direct deploy.
 *
 * Home Assistant's ingress serves an add-on at `/api/hassio_ingress/<token>/`
 * and passes that prefix in `X-Ingress-Path`. Server-rendered links and the
 * client's own fetches have to carry it, or they resolve against Home Assistant
 * instead of this app — the page loads and every request under it 404s, which
 * reads as "the add-on is broken" rather than "the URLs are wrong".
 *
 * Two things this deliberately does NOT do:
 *
 * 1. It does not try to STRIP the prefix from the path. The prefix *is*
 *    `/api/hassio_ingress/<token>`, so a regex anchored on `/api` matches at
 *    position 0 and removes the wrong thing. Ingress already delivers the
 *    unprefixed path; only outbound URLs need the prefix added back.
 *
 * 2. It is never used as authorization. Every add-on on a Home Assistant host
 *    shares the `172.30.32.0/23` bridge, so anything co-resident can set this
 *    header — it is a claim from an unauthenticated party. Trusting it to mean
 *    "Home Assistant already checked the session" is the exact bug the fleet
 *    shipped and fixed once. It decides URL shape and nothing else, so a forged
 *    value can only make the forger's own links wrong.
 */
export function ingressBase(request: Request): string {
  const raw = request.headers.get("x-ingress-path") ?? "";
  // Only a rooted, single-line path. Anything else is discarded rather than
  // interpolated into the page.
  if (!/^\/[\w\-./]*$/.test(raw)) return "";
  return raw.replace(/\/+$/, "");
}

/**
 * The header a trusted front door writes the peer address into.
 *
 * Set by server.ts from the socket, and OVERWRITTEN there unconditionally so a
 * client cannot supply its own. Nothing outside that one assignment may write
 * it, which is the only reason anything downstream is allowed to believe it.
 */
export const PEER_IP_HEADER = "x-trace-peer-ip";

/** Home Assistant's own address on the hassio bridge — the one peer ingress can come from. */
export const DEFAULT_INGRESS_PEER = "172.30.32.2";

/** The only shape `X-Ingress-Path` takes when Supervisor wrote it. */
const INGRESS_PATH = /^\/api\/hassio_ingress\/[A-Za-z0-9_-]{1,256}$/;
/** HA user ids, as Supervisor forwards them in `X-Remote-User-Id`. */
const HA_USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface IngressCheck {
  ok: boolean;
  /** `X-Remote-User-Id`, read only AFTER the peer check passed; "" when absent. */
  haUser: string;
  /** `X-Remote-User-Name`, control characters stripped, for the deny page only
   *  (PRD §3.9 #6). Display text, never identity. "" when absent. */
  haUserName: string;
}

/** The display name Supervisor forwards, minus anything that is not printable. */
const haUserNameOf = (raw: string | null): string =>
  (raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 256);

/**
 * Did this request come through Home Assistant's ingress, for real? — Pattern B
 * (PRD §3.9 #6).
 *
 * `X-Ingress-Path` alone answers nothing — it is one header, and anyone who can
 * open a socket to the published port can send it. What cannot be forged over
 * that port is the source address. digger accepted ANY peer inside the
 * `172.30.32.0/23` bridge (Pattern A); trace-node requires the peer to EQUAL
 * `ingress_peer`, because at gate 3 the cloudflared container also lives on
 * that bridge, and under Pattern A every internet caller sending
 * `X-Ingress-Path` through it would have been admitted as ingress.
 *
 * So: exact peer, a path in Supervisor's own shape, and only then is
 * `X-Remote-User-Id` read. A peer inside `trusted_proxies` can never be the
 * ingress peer — boot refuses the overlap, and this refuses it again.
 *
 * `X-Forwarded-For` is never consulted here: the stamped socket peer is the
 * only address this trusts.
 */
export function fromIngress(
  request: Request,
  ingressPeer: string = DEFAULT_INGRESS_PEER,
  trustedProxies: readonly string[] = [],
): IngressCheck {
  const refused: IngressCheck = { ok: false, haUser: "", haUserName: "" };
  const path = request.headers.get("x-ingress-path") ?? "";
  if (!INGRESS_PATH.test(path)) return refused;
  const peer = (request.headers.get(PEER_IP_HEADER) ?? "").trim();
  if (!peer) return refused;
  // ::ffff:172.30.32.2 is how a dual-stack listener reports a v4 peer.
  const v4 = peer.replace(/^::ffff:/i, "");
  if (ipv4ToInt(v4) === null || ipv4ToInt(v4) !== ipv4ToInt(ingressPeer)) return refused;
  if (ipInCidrs(v4, trustedProxies)) return refused;
  const id = (request.headers.get("x-remote-user-id") ?? "").trim();
  return {
    ok: true,
    haUser: HA_USER_ID.test(id) ? id : "",
    haUserName: haUserNameOf(request.headers.get("x-remote-user-name")),
  };
}

/** The socket peer server.ts stamped, or null under `bun test`. */
export function peerOf(request: Request): string | null {
  return request.headers.get(PEER_IP_HEADER)?.trim() || null;
}

// ── trusted proxies (PRD §3.9 #2) ────────────────────────────────────────────
//
// Forwarded headers are a claim from whoever opened the socket. They are
// believed only when the socket peer is inside `trusted_proxies` — default
// EMPTY, so on a mapped port a LAN or NetBird caller sending a fresh
// `cf-connecting-ip` per request no longer mints itself a fresh guessing
// budget per request. The only intended member is the cloudflared container
// on the hassio bridge at gate 3.

/** The forwarded headers a proxy writes and a client can forge. */
export const FORWARDED_HEADERS = ["cf-connecting-ip", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"] as const;

/** IPv4 dotted quad → 32-bit integer, or null. `::ffff:` prefix tolerated. */
export function ipv4ToInt(ip: string): number | null {
  const v4 = ip.trim().replace(/^::ffff:/i, "");
  const parts = v4.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

/** `"10.0.0.1, 172.30.32.0/23"` → the list; non-IPv4 entries match exactly. */
export function parseCidrs(input: string | string[] | undefined | null): string[] {
  const raw = Array.isArray(input) ? input : String(input ?? "").split(",");
  return raw.map((s) => s.trim()).filter(Boolean);
}

/** Is `ip` inside any entry of the list (IPv4 CIDR or exact address)? */
export function ipInCidrs(ip: string, cidrs: readonly string[]): boolean {
  if (!ip) return false;
  const addr = ipv4ToInt(ip);
  for (const entry of cidrs) {
    const [base, bitsText] = entry.split("/");
    const baseInt = ipv4ToInt(base ?? "");
    if (addr === null || baseInt === null) {
      if (entry === ip || entry === ip.replace(/^::ffff:/i, "")) return true;
      continue;
    }
    const bits = bitsText === undefined ? 32 : Number(bitsText);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((addr & mask) >>> 0) === ((baseInt & mask) >>> 0)) return true;
  }
  return false;
}

/** Did this request arrive from a proxy whose forwarded headers are believed? */
export function fromTrustedProxy(request: Request, trustedProxies: readonly string[] = []): boolean {
  if (trustedProxies.length === 0) return false;
  const peer = peerOf(request);
  return peer !== null && ipInCidrs(peer, trustedProxies);
}

/** The client address a TRUSTED proxy forwarded, else null. */
export function forwardedClient(request: Request, trustedProxies: readonly string[] = []): string | null {
  if (!fromTrustedProxy(request, trustedProxies)) return null;
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const xff = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || null;
}

/**
 * The caller's address: what a trusted proxy forwarded, else the socket peer
 * that server.ts stamped. Neither exists in `bun test`, hence null rather than
 * a placeholder — a ledger row reading "local" for every caller answers the
 * question wrongly, and null renders as "—".
 *
 * Distinct from ratelimit's clientIp(), which needs a non-null bucket key and
 * so falls back to a constant. Here the honest answer is "not known".
 */
export function remoteAddress(request: Request, trustedProxies: readonly string[] = []): string | null {
  return forwardedClient(request, trustedProxies) ?? peerOf(request);
}

/** 172.30.32.0/23 — the docker network Supervisor puts add-ons and core on. */
export function isHassioBridge(ip: string): boolean {
  // ::ffff:172.30.32.1 is how a dual-stack listener reports a v4 peer.
  const v4 = ip.replace(/^::ffff:/i, "");
  const parts = v4.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  // /23 starting at 172.30.32.0 covers 172.30.32.x and 172.30.33.x.
  return octets[0] === 172 && octets[1] === 30 && (octets[2] === 32 || octets[2] === 33);
}

/** 'vocabulary:term' → parts. A bare name lands in the default vocabulary. */
export function parseTermRef(raw: string, defaultVocabulary = "tags"): { vocabulary: string; name: string } | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const idx = value.indexOf(":");
  const vocabulary = idx > 0 ? value.slice(0, idx).trim() : defaultVocabulary;
  const name = idx > 0 ? value.slice(idx + 1).trim() : value;
  if (!name) return null;
  return { vocabulary, name };
}
