/**
 * Who is connected to this corpus — the ledger behind the Access panel.
 *
 * Ported from digger-wiki-haos, which answered the question first. The shape is
 * the same and the reasoning is the same; what changed is the storage. That
 * add-on holds one long-lived bun process and could coalesce writes in memory,
 * flushing every five seconds. This app also runs on a Cloudflare Worker, where
 * the isolate serving your next request may not be the one that buffered the
 * last — so an in-memory buffer would drop counts silently on exactly the
 * deployment people can see from the internet. Each countable request writes
 * its own UPSERT instead: more writes, and a number that is true.
 *
 * One row per (method, principal), never one per request:
 *
 *   oauth          principal = client_id. The label says "claude.ai" only when
 *                  the client REGISTERED a claude.ai callback — Claude Code can
 *                  also arrive over OAuth, and labelling every OAuth client
 *                  claude.ai would answer the question wrongly in precisely the
 *                  case worth asking about.
 *   api-token      principal = the user-agent family. One static secret is
 *                  shared by every script, so the UA is the only identity there
 *                  is, and pretending otherwise would invent precision.
 *   ingress        principal = the SOCKET peer (always the hassio bridge), so
 *                  the sidebar is one row however many people open it. The
 *                  visitor's public address is kept as remote_ip, displayed and
 *                  never identity — see principalOf().
 *   owner-session  principal = "browser". Every browser tab is the owner.
 *
 * Nothing here stores a credential. The bearer that proved a caller is
 * discarded at the gate; only the method survives.
 */

import { getClient } from "./oauth";
import { CONNECTIONS } from "./sql";
import type { Store } from "./store/types";
import { nowIso, PEER_IP_HEADER, type Clock } from "./utils";

export type ConnectionMethod = "open" | "owner-session" | "api-token" | "oauth" | "ingress";
export type Since = "24h" | "7d" | "all";
/** connected = called within the hour · idle = has a token, has not called · none = never registered. */
export type ClaudeAiState = "connected" | "idle" | "none";

export const INGRESS_LABEL = "HA sidebar";
export const BROWSER_LABEL = "Browser session";
export const CLAUDE_AI = "claude.ai";

export interface Connection {
  id: string;
  method: ConnectionMethod;
  label: string;
  /** Shortened for OAuth: a client_id is not a secret, but eight characters
   *  identify it in a table and twenty-two only clutter the row. */
  principal: string;
  userAgent: string | null;
  remoteIp: string | null;
  firstSeen: string;
  lastSeen: string;
  requests: number;
  toolCalls: number;
  lastTool: string | null;
}

/**
 * The family a user-agent belongs to.
 *
 * Claude Code, Codex and curl are the callers that actually carry the static
 * token; anything else is named by its product token — the part before the
 * first `/`, which is the part of a UA meant to name the product.
 */
export function uaFamily(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "unknown";
  if (/claude[-_ ]?code|claude[-_]cli/i.test(ua)) return "Claude Code";
  if (/codex/i.test(ua)) return "Codex";
  if (/(^|\s)curl\//i.test(ua)) return "curl";
  const product = /^([A-Za-z0-9][A-Za-z0-9._+-]*)/.exec(ua);
  return product ? product[1]! : "unknown";
}

const CLAUDE_AI_HOST = /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/i;

/** Did this client register a callback on a claude.ai host? The single fact
 *  that separates claude.ai from any other OAuth-capable MCP client. */
export function isClaudeAiClient(redirectUris: string[]): boolean {
  return redirectUris.some((uri) => {
    try {
      return CLAUDE_AI_HOST.test(new URL(uri).hostname);
    } catch {
      return false;
    }
  });
}

/**
 * Paths that are not a client "using the corpus".
 *
 * The health probe is a monitor, not a caller, and counting it would make an
 * unattended node look busy. The page's own GET / is excluded for the same
 * reason the sidebar is not counted twice: it is the shell, not the work.
 */
export function countable(pathname: string): boolean {
  if (pathname === "/health") return false;
  if (pathname === "/" || pathname === "/index.html") return false;
  if (pathname === "/favicon.ico") return false;
  if (pathname.startsWith("/.well-known/")) return false;
  return true;
}

export function parseSince(value: string | null | undefined): Since {
  return value === "7d" || value === "all" ? value : "24h";
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS: Record<Since, number> = { "24h": DAY_MS, "7d": 7 * DAY_MS, all: 0 };

async function labelOf(
  store: Store,
  method: ConnectionMethod,
  principal: string,
): Promise<string> {
  if (method === "ingress") return INGRESS_LABEL;
  if (method === "api-token") return principal;
  if (method !== "oauth") return BROWSER_LABEL;

  const client = await getClient(store, principal).catch(() => null);
  const name = client?.clientName?.trim() || principal.slice(0, 8);
  return client && isClaudeAiClient(client.redirectUris ?? [])
    ? `${CLAUDE_AI} · ${name}`
    : `OAuth · ${name}`;
}

/**
 * The stable identity of a caller — the half of the row that must NOT vary per
 * request, because it is the primary key.
 *
 * Ingress is the subtle one. The obvious choice is "the address it came from",
 * and that was wrong: behind the Cloudflare tunnel `cf-connecting-ip` is the
 * END USER's public address, so every visitor minted a new "HA sidebar" row and
 * the table grew without bound. Seen live — a row reading
 * `HA sidebar · ingress · 124.121.144.27` where a bridge address belonged.
 *
 * The sidebar is ONE caller: Home Assistant, proxying for whoever is signed
 * into it. So the principal is the SOCKET peer (always the hassio bridge), and
 * the visitor's public address is kept as `remote_ip` — displayed, never
 * identity. One row, and it still tells you who last opened the panel.
 */
export function principalOf(
  method: ConnectionMethod,
  clientId: string | undefined,
  request: Request,
): string {
  switch (method) {
    case "oauth":
      return clientId ?? "unknown";
    case "api-token":
      return uaFamily(request.headers.get("user-agent"));
    case "ingress":
      return request.headers.get(PEER_IP_HEADER)?.trim() || "ingress";
    default:
      return "browser";
  }
}

/**
 * Fold one authenticated request into the ledger.
 *
 * Never throws. A ledger is an observation of the service, and an observation
 * that can take the service down is worse than no observation — a failed UPSERT
 * here must not turn a working request into a 500.
 */
export async function record(
  store: Store,
  auth: { method?: string; clientId?: string },
  request: Request,
  remoteIp: string | null,
  /** `tool` marks a tools/call; `requests: 0` lets the /mcp handler add the
   *  tool without counting the request twice — the gate already did (PRD §3.9 #1). */
  options: { tool?: string; requests?: number } = {},
  clock?: Clock,
): Promise<void> {
  const method = auth.method as ConnectionMethod | undefined;
  // "open" is not a caller identity — with no credentials configured every
  // request would fold into one meaningless row.
  if (!method || method === "open") return;

  try {
    const principal = principalOf(method, auth.clientId, request);
    const label = await labelOf(store, method, principal);
    const now = nowIso(clock);
    await store.run(CONNECTIONS.upsert, [
      `${method}:${principal}`,
      method,
      principal,
      label,
      request.headers.get("user-agent"),
      remoteIp,
      now,
      now,
      options.requests ?? 1,
      options.tool ? 1 : 0,
      options.tool ?? null,
    ]);
  } catch {
    // Deliberately silent: see the note above.
  }
}

const rowToConnection = (row: Record<string, unknown>): Connection => ({
  id: String(row.id),
  method: row.method as ConnectionMethod,
  label: String(row.label),
  principal: row.method === "oauth" ? String(row.principal).slice(0, 8) : String(row.principal),
  userAgent: (row.user_agent as string) ?? null,
  remoteIp: (row.remote_ip as string) ?? null,
  firstSeen: String(row.first_seen),
  lastSeen: String(row.last_seen),
  requests: Number(row.requests ?? 0),
  toolCalls: Number(row.tool_calls ?? 0),
  lastTool: (row.last_tool as string) ?? null,
});

export async function list(store: Store, since: Since = "24h"): Promise<Connection[]> {
  const window = WINDOW_MS[since];
  const cutoff = window === 0 ? "" : new Date(Date.now() - window).toISOString();
  const rows = await store.all<Record<string, unknown>>(CONNECTIONS.list, [cutoff, cutoff]);
  return rows.map(rowToConnection);
}

/**
 * Is claude.ai connected, idle, or absent?
 *
 * Three states rather than a boolean, because "registered a client" and "is
 * actually calling" are different facts and a panel that conflates them tells
 * you the wrong thing on the day it matters. Idle is the interesting one: a
 * live token that has gone quiet.
 */
export async function claudeAiState(store: Store): Promise<ClaudeAiState> {
  const rows = await list(store, "all");
  const claude = rows.filter((row) => row.label.startsWith(CLAUDE_AI));
  if (claude.length === 0) return "none";
  const hourAgo = Date.now() - 60 * 60 * 1000;
  return claude.some((row) => Date.parse(row.lastSeen) >= hourAgo) ? "connected" : "idle";
}
