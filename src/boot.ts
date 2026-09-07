/**
 * Fail-closed boot (PRD §6.3): what must be true of the environment BEFORE the
 * port is bound. Each failure is one line and exit 1 — never a generated
 * credential, never a fixed fallback, never OPEN by accident.
 *
 * A pure function of the env so it can be unit-tested without spawning a
 * process; server.ts calls it first and prints what it returns.
 */

import { DEFAULT_INGRESS_PEER, ipInCidrs, ipv4ToInt, isHassioBridge, parseCidrs } from "./utils";

export type BootEnv = Record<string, string | undefined>;

/** Boot refuses an api_token shorter than this (PRD §3.9 #11). */
export const MIN_API_TOKEN = 24;
/** Boot refuses an owner_passphrase shorter than this (PRD §2 Passphrase row, §6.3). */
export const MIN_BOOT_PASSPHRASE = 12;

const truthy = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
const falsy = (value: string | undefined): boolean =>
  ["0", "false", "no", "off"].includes((value ?? "").trim().toLowerCase());

const NO_PASSPHRASE =
  "trace-node: owner_passphrase is not set; refusing to start OPEN. " +
  "Set it in the add-on options, or set require_owner_passphrase=false with an api_token.";

/**
 * The reason not to start, or null. Checked in the order PRD §6.3 lists:
 *
 *   1. require_owner_passphrase (default true) and OWNER_PASSPHRASE blank
 *   2. require_owner_passphrase=false and both OWNER_PASSPHRASE and API_TOKEN blank
 *   3. API_TOKEN shorter than 24
 *   4. OWNER_PASSPHRASE shorter than 12
 *   5. INGRESS_PEER not one IPv4 inside 172.30.32.0/23, or inside TRUSTED_PROXIES
 *   6. ALLOW_OPEN=1 or INGRESS_TRUSTED_PEER while SUPERVISOR_TOKEN is set or
 *      DB_PATH is under /data — OPEN mode and proof-proxy peers exist for local
 *      tests only
 *   7. INGRESS_AUTO_LOGIN_HA_ADMINS on without SUPERVISOR_TOKEN — the admin
 *      lookup can never succeed, so every unlisted HA user would be denied
 *      by an outage the operator cannot see. Refused at boot instead (§8.1b;
 *      the add-on grants `homeassistant_api: true`, which is what supplies
 *      the token).
 *
 * `ALLOW_OPEN=1` is the only way to start with no credential, and rule 6 makes
 * it unreachable inside the add-on. The module-load SQLite smoke needs the
 * store and lives in server.ts.
 *
 * There is deliberately NO env knob for where the admin lookup connects: it is
 * `ws://supervisor/core/websocket` (ha-admin.ts) and nothing else. A fake Core
 * is exercised in-process (test/ingress-admission.test.ts) by handing
 * `createApp` a checker built on a test URL — the entry point never reads one.
 */
export function bootProblem(env: BootEnv): string | null {
  const passphrase = (env.OWNER_PASSPHRASE ?? "").trim();
  const apiToken = (env.API_TOKEN ?? "").trim();
  const allowOpen = truthy(env.ALLOW_OPEN);
  const requirePassphrase = !falsy(env.REQUIRE_OWNER_PASSPHRASE);
  const insideAddon = Boolean((env.SUPERVISOR_TOKEN ?? "").trim()) || (env.DB_PATH ?? "").startsWith("/data");

  if (!allowOpen) {
    if (requirePassphrase && !passphrase) return NO_PASSPHRASE;
    if (!requirePassphrase && !passphrase && !apiToken) return NO_PASSPHRASE;
  }
  if (apiToken && apiToken.length < MIN_API_TOKEN) {
    return `trace-node: api_token is shorter than ${MIN_API_TOKEN} characters; refusing to start. Generate one with: openssl rand -base64 32`;
  }
  if (passphrase && passphrase.length < MIN_BOOT_PASSPHRASE) {
    return `trace-node: owner_passphrase is shorter than ${MIN_BOOT_PASSPHRASE} characters; refusing to start.`;
  }

  const ingressPeer = (env.INGRESS_PEER ?? "").trim() || DEFAULT_INGRESS_PEER;
  const trusted = parseCidrs(env.TRUSTED_PROXIES);
  if (ipv4ToInt(ingressPeer) === null || ingressPeer.includes("/") || !isHassioBridge(ingressPeer)) {
    return `trace-node: ingress_peer "${ingressPeer}" is not one IPv4 address inside 172.30.32.0/23; refusing to start.`;
  }
  if (ipInCidrs(ingressPeer, trusted)) {
    return `trace-node: ingress_peer "${ingressPeer}" is inside trusted_proxies; a trusted proxy can never be the ingress peer. Refusing to start.`;
  }

  if (insideAddon && allowOpen) {
    return "trace-node: ALLOW_OPEN is set inside the add-on; OPEN mode exists for local tests only. Refusing to start.";
  }
  if (insideAddon && (env.INGRESS_TRUSTED_PEER ?? "").trim()) {
    return "trace-node: INGRESS_TRUSTED_PEER is set inside the add-on; proof-proxy peers exist for local tests only. Refusing to start.";
  }
  if (truthy(env.INGRESS_AUTO_LOGIN_HA_ADMINS) && !(env.SUPERVISOR_TOKEN ?? "").trim()) {
    return "trace-node: auto_login_ha_admins is on but SUPERVISOR_TOKEN is not set; the admin lookup needs homeassistant_api: true. Refusing to start.";
  }

  return null;
}
