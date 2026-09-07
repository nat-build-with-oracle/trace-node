/**
 * Ingress admission (PRD §8.1b "decided v0.4.1") and the CORS preflight
 * (1b-2 open item), end to end through the gate.
 *
 * Order of admission, each step its own test:
 *   ingress proven (fromIngress, gate 1a) → X-Remote-User-Id present →
 *   listed id OR (admins on AND Core says admin) → session;
 *   otherwise the 403 deny page — the id, the option, no token.
 *
 * The admin lookup is exercised two ways: a fake `isHaAdmin` on the config
 * (the cache and the fail-closed rules), and the real `adminChecker` +
 * `readAdminIds` against a fake Core websocket (the wire).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createApp } from "../src/app";
import type { AuthConfig } from "../src/auth";
import { callerOf } from "../src/auth-plugin";
import { bootProblem } from "../src/boot";
import { adminChecker, readAdminIds } from "../src/ha-admin";
import { openSqliteStore } from "../src/store/sqlite";
import type { Store } from "../src/store/types";

const migrations = readdirSync(join(import.meta.dir, "..", "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({ name: file, sql: readFileSync(join(import.meta.dir, "..", "migrations", file), "utf8") }));

const PASSPHRASE = "open-sesame-please";
const PEER = "172.30.32.2";
const PATH = "/api/hassio_ingress/tok";

let store: Store;
beforeEach(async () => {
  store = await openSqliteStore(":memory:", migrations);
});

const appWith = (auth: Partial<AuthConfig>) =>
  createApp({ store, instanceName: "test-node", auth: { ownerPassphrase: PASSPHRASE, ingressAutoLogin: true, ...auth } });

/** A request Supervisor would forward: right peer, right path, a named user. */
const ingress = (id: string | null, extra: Record<string, string> = {}, path = "/api/nodes") =>
  new Request(`http://localhost${path}`, {
    headers: { "x-ingress-path": PATH, "x-trace-peer-ip": PEER, ...(id === null ? {} : { "x-remote-user-id": id }), ...extra },
  });
const asJson = { accept: "application/json" };

const DENY_KEYS = ["allowlistOption", "ok", "user_id", "user_name"];

describe("ingress admission — the allowlist", () => {
  test("allowlist admit: a listed id is signed in with ha_user recorded, no lookup consulted", async () => {
    let asked = 0;
    const app = appWith({
      ingressAutoLoginHaUserIds: ["nat", "other"],
      isHaAdmin: async () => {
        asked++;
        return false;
      },
    });
    const request = ingress("nat");
    const response = await app.fetch(request);
    expect(response.status).toBe(200);
    expect(callerOf(request)).toMatchObject({ method: "ingress", principal: PEER, ha_user: "nat" });
    expect(asked).toBe(0);
  });

  test("allowlist deny: 403 JSON naming the id, the name and the option — exactly four keys, no-store, no cookie", async () => {
    const app = appWith({ ingressAutoLoginHaUserIds: ["other"] });
    const response = await app.fetch(ingress("nat", { ...asJson, "x-remote-user-name": "Nat W" }));
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("www-authenticate")).toBeNull(); // not the OAuth 401
    const body = (await response.json()) as any;
    expect(Object.keys(body).sort()).toEqual(DENY_KEYS);
    expect(body).toEqual({ ok: false, user_id: "nat", user_name: "Nat W", allowlistOption: "auto_login_ha_user_ids" });
  });

  test("allowlist deny: the HTML page when Accept is not json — id and option in a JSON block, textContent, Copy-ID, no form", async () => {
    const app = appWith({ ingressAutoLoginHaUserIds: ["other"] });
    const response = await app.fetch(ingress("nat", { "x-remote-user-name": "Nat W" }));
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    const html = await response.text();
    expect(html).toContain('<script type="application/json" id="deny-data">');
    expect(html).toContain('{"ok":false,"user_id":"nat","user_name":"Nat W","allowlistOption":"auto_login_ha_user_ids"}');
    expect(html).toContain("textContent");
    expect(html).not.toContain("innerHTML");
    expect(html).toContain("Copy ID");
    expect(html).toContain("auto_login_ha_user_ids");
    // No passphrase form is offered through ingress (PRD §3.9 #7).
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("<form");
  });

  test("the deny page never interpolates the name raw: control chars stripped, markup escaped in HTML and in the JSON block", async () => {
    const app = appWith({ ingressAutoLoginHaUserIds: ["other"] });
    const hostile = 'Ev\u0001</script><script>alert(1)</script>il\u001f"&';
    const response = await app.fetch(ingress("nat", { "x-remote-user-name": hostile }));
    const html = await response.text();
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).not.toContain("\u0001");
    expect(html).not.toContain("\u001f");
    // The JSON block carries it with `<` escaped, so it cannot close the block.
    expect(html).toContain('"user_name":"Ev\\u003c/script>\\u003cscript>alert(1)\\u003c/script>il\\"&"');
    // The noscript copy is HTML-escaped.
    expect(html).toContain("(Ev&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;il&quot;&amp;)");

    const json = (await (await app.fetch(ingress("nat", { ...asJson, "x-remote-user-name": hostile }))).json()) as any;
    expect(json.user_name).toBe('Ev</script><script>alert(1)</script>il"&');
  });

  test("GET / through ingress for a denied user is the deny page, not the lock screen and not the app", async () => {
    const app = appWith({ ingressAutoLoginHaUserIds: ["other"] });
    const response = await app.fetch(ingress("nat", {}, "/"));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("Copy ID");
    expect(html).not.toContain('action="/api/hassio_ingress/tok/login"');
    expect(html).not.toContain("__BASE__");
  });

  test("a denied user stays denied: nothing was minted, the next request is 403 again", async () => {
    const app = appWith({ ingressAutoLoginHaUserIds: ["other"] });
    expect((await app.fetch(ingress("nat"))).status).toBe(403);
    expect((await app.fetch(ingress("nat", {}, "/api/health"))).status).toBe(403);
    expect((await app.fetch(ingress("nat", {}, "/mcp"))).status).toBe(403);
    // …and the deny page counted nobody into the ledger.
    const rows = await store.all<{ n: number }>("SELECT COUNT(*) AS n FROM connections", []);
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  test("missing X-Remote-User-Id → 401 with the OAuth challenge, not a deny page — even with an empty list", async () => {
    for (const auth of [{}, { ingressAutoLoginHaUserIds: ["nat"] }, { ingressAutoLoginHaAdmins: true, isHaAdmin: async () => true }]) {
      const app = appWith(auth);
      const response = await app.fetch(ingress(null, asJson));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain('Bearer realm="trace-node"');
      expect(((await response.json()) as any).error).toBe("unauthorized");
      // An id Supervisor would never write (wrong charset) counts as absent.
      const junk = await app.fetch(ingress("not a user id!", asJson));
      expect(junk.status).toBe(401);
    }
  });

  // 1b-3 fix (PRD §3.9 #7): with auto_login on the passphrase form is not
  // offered through ingress AT ALL — not to a denied user (above), not to a
  // request that named nobody, not to one that only claimed to be ingress.
  const NO_FORM = (html: string) => {
    expect(html).not.toContain("<form");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("/login");
  };
  const CONFIGS: Array<Partial<AuthConfig>> = [
    {}, // the §8.2 gate-2 shape: empty list, admins off
    { ingressAutoLoginHaUserIds: ["nat"] },
    { ingressAutoLoginHaAdmins: true, isHaAdmin: async () => true },
  ];

  test("GET / through ingress with no X-Remote-User-Id → 401 form-less page, no cookie — every config, never the lock screen", async () => {
    for (const auth of CONFIGS) {
      const app = appWith(auth);
      const response = await app.fetch(ingress(null, {}, "/"));
      expect({ auth, status: response.status }).toEqual({ auth, status: 401 });
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
      const html = await response.text();
      NO_FORM(html);
      expect(html).toContain("Home Assistant ingress did not provide a user id");
      expect(html).not.toContain("__BASE__"); // not the app either

      // A malformed id counts as absent (same charset rule as the gate).
      const junk = await app.fetch(ingress("not a user id!", {}, "/"));
      expect(junk.status).toBe(401);
      NO_FORM(await junk.text());

      // Accept: json → the gate's 401 shape, same description, no challenge
      // header (an iframe is not an MCP client), still no cookie.
      const json = await app.fetch(ingress(null, asJson, "/"));
      expect(json.status).toBe(401);
      expect(json.headers.get("content-type")).toBe("application/json");
      expect(json.headers.get("set-cookie")).toBeNull();
      expect(await json.json()).toEqual({ error: "unauthorized", error_description: "Home Assistant ingress did not provide a user id" });
    }
  });

  test("GET / with X-Ingress-Path but not from the ingress peer, auto_login on → 401 form-less 'ingress required', not the lock screen", async () => {
    const app = appWith({});
    // Right header, wrong peer: the header is a claim, the peer is the proof.
    const forged = new Request("http://localhost/", { headers: { "x-ingress-path": PATH, "x-trace-peer-ip": "10.0.0.9", "x-remote-user-id": "nat" } });
    const response = await app.fetch(forged);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    const html = await response.text();
    NO_FORM(html);
    expect(html).toContain("Home Assistant ingress required");
    // Without the header the mapped port still gets the lock screen (auto_login
    // governs ingress only — PRD §3.9 #7 says "through ingress").
    const direct = await app.fetch(new Request("http://localhost/", { headers: { "x-trace-peer-ip": "10.0.0.9" } }));
    expect(direct.status).toBe(200);
    expect(await direct.text()).toContain('type="password"');
  });

  test("POST /login through ingress with auto_login on → 403, no cookie, the passphrase never checked — even the right one", async () => {
    for (const auth of CONFIGS) {
      const app = appWith(auth);
      const post = (id: string | null, extra: Record<string, string> = {}) =>
        new Request("http://localhost/login", {
          method: "POST",
          headers: {
            "x-ingress-path": PATH,
            "x-trace-peer-ip": PEER,
            "content-type": "application/x-www-form-urlencoded",
            ...(id === null ? {} : { "x-remote-user-id": id }),
            ...extra,
          },
          body: new URLSearchParams({ passphrase: PASSPHRASE }).toString(),
        });
      for (const id of [null, "nat", "other"]) {
        const response = await app.fetch(post(id));
        expect({ auth, id, status: response.status }).toEqual({ auth, id, status: 403 });
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(response.headers.get("cache-control")).toBe("no-store");
        NO_FORM(await response.text());
      }
      const json = await app.fetch(post(null, asJson));
      expect(json.status).toBe(403);
      expect(await json.json()).toEqual({ error: "forbidden", error_description: "The passphrase form is not offered through Home Assistant ingress" });
      // The refusal is not a failed attempt: the login bucket is untouched.
      const rows = await store.all<{ n: number }>("SELECT COUNT(*) AS n FROM auth_attempts", []);
      expect(Number(rows[0]?.n ?? 0)).toBe(0);
    }
    // GET /login stays the 302 it was (auth.test.ts pins it) — no form there either.
    const get = await appWith({}).fetch(ingress(null, {}, "/login"));
    expect(get.status).toBe(302);
    expect(get.headers.get("location")).toBe(`${PATH}/`);
  });

  test("empty list, admins off: any HA-authenticated user is admitted with ha_user recorded (PRD §3.9 #6, §8.2)", async () => {
    const app = appWith({ ingressAutoLoginHaUserIds: [] });
    const request = ingress("anyone");
    expect((await app.fetch(request)).status).toBe(200);
    expect(callerOf(request)).toMatchObject({ method: "ingress", ha_user: "anyone" });
  });
});

describe("ingress admission — auto_login_ha_admins", () => {
  test("admins on: Core says admin → admitted; Core says no → deny page naming the id", async () => {
    const app = appWith({
      ingressAutoLoginHaAdmins: true,
      isHaAdmin: async (id) => id === "root",
    });
    const admin = ingress("root");
    expect((await app.fetch(admin)).status).toBe(200);
    expect(callerOf(admin)).toMatchObject({ method: "ingress", ha_user: "root" });

    const denied = await app.fetch(ingress("guest", { ...asJson, "x-remote-user-name": "Guest" }));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ ok: false, user_id: "guest", user_name: "Guest", allowlistOption: "auto_login_ha_user_ids" });
  });

  test("admins on with a non-empty list: listed OR admin gets in, the lookup runs only for the unlisted", async () => {
    const asked: string[] = [];
    const app = appWith({
      ingressAutoLoginHaAdmins: true,
      ingressAutoLoginHaUserIds: ["listed"],
      isHaAdmin: async (id) => {
        asked.push(id);
        return id === "root";
      },
    });
    expect((await app.fetch(ingress("listed"))).status).toBe(200);
    expect((await app.fetch(ingress("root"))).status).toBe(200);
    expect((await app.fetch(ingress("guest"))).status).toBe(403);
    expect(asked).toEqual(["root", "guest"]);
  });

  test("admins on, empty list: the stricter reading — only admins, not everyone", async () => {
    const app = appWith({ ingressAutoLoginHaAdmins: true, ingressAutoLoginHaUserIds: [], isHaAdmin: async () => false });
    expect((await app.fetch(ingress("anyone"))).status).toBe(403);
  });

  test("lookup failure → deny (fail closed): a throwing checker, a rejecting one, and no checker at all", async () => {
    const throwing = appWith({
      ingressAutoLoginHaAdmins: true,
      isHaAdmin: async () => {
        throw new Error("Core unreachable");
      },
    });
    expect((await throwing.fetch(ingress("root"))).status).toBe(403);

    const rejecting = appWith({ ingressAutoLoginHaAdmins: true, isHaAdmin: () => Promise.reject(new Error("timeout")) });
    expect((await rejecting.fetch(ingress("root"))).status).toBe(403);

    // No SUPERVISOR_TOKEN → server.ts passes no checker → nobody is an admin.
    const none = appWith({ ingressAutoLoginHaAdmins: true });
    expect((await none.fetch(ingress("root"))).status).toBe(403);
    // A listed id still gets in without any lookup.
    const listed = appWith({ ingressAutoLoginHaAdmins: true, ingressAutoLoginHaUserIds: ["nat"] });
    expect((await listed.fetch(ingress("nat"))).status).toBe(200);
  });

  test("cache 60 s: many requests → one Core read; the minute passes → a second read that can revoke", async () => {
    let now = 1_700_000_000_000;
    let loads = 0;
    let admins = new Set(["root"]);
    const app = appWith({
      ingressAutoLoginHaAdmins: true,
      isHaAdmin: adminChecker(
        async () => {
          loads++;
          return admins;
        },
        () => now,
      ),
    });
    for (let i = 0; i < 5; i++) expect((await app.fetch(ingress("root"))).status).toBe(200);
    expect((await app.fetch(ingress("guest"))).status).toBe(403);
    expect(loads).toBe(1);

    admins = new Set(); // root demoted in HA — not seen until the minute is up
    now += 59_000;
    expect((await app.fetch(ingress("root"))).status).toBe(200);
    expect(loads).toBe(1);
    now += 1_000;
    expect((await app.fetch(ingress("root"))).status).toBe(403);
    expect(loads).toBe(2);
  });

  test("admins on via the real lookup against a fake Core websocket: owner and system-admin admitted, a user denied", async () => {
    const credential = crypto.randomUUID();
    const commands: string[] = [];
    const core = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, s) {
        if (s.upgrade(request)) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: "auth_required" }));
        },
        message(ws, data) {
          const m = JSON.parse(String(data));
          commands.push(m.type);
          if (m.type === "auth") {
            ws.send(JSON.stringify(m.access_token === credential ? { type: "auth_ok" } : { type: "auth_invalid" }));
          } else {
            ws.send(
              JSON.stringify({
                type: "result",
                id: m.id,
                success: true,
                result: [
                  { id: "owner", name: "Nat", is_active: true, is_owner: true, group_ids: ["system-admin"] },
                  { id: "admin", name: "Ops", is_active: true, is_owner: false, group_ids: ["system-admin"] },
                  { id: "user", name: "Guest", is_active: true, is_owner: false, group_ids: ["system-users"] },
                  { id: "gone", name: "Old", is_active: false, is_owner: true, group_ids: ["system-admin"] },
                ],
              }),
            );
          }
        },
      },
    });
    const url = `ws://127.0.0.1:${core.port}`;
    console.log(`ingress-admission.test: fake Core websocket listening on ${url}`);
    try {
      const app = appWith({
        ingressAutoLoginHaAdmins: true,
        isHaAdmin: adminChecker(() => readAdminIds(url, credential)),
      });
      expect((await app.fetch(ingress("owner"))).status).toBe(200);
      expect((await app.fetch(ingress("admin"))).status).toBe(200);
      expect((await app.fetch(ingress("user"))).status).toBe(403);
      expect((await app.fetch(ingress("gone"))).status).toBe(403);
      // One websocket conversation served all four requests, and it sent
      // nothing but auth + the one read-only command.
      expect(commands).toEqual(["auth", "config/auth/list"]);

      // A wrong token at Core denies everyone — fail closed on the wire too.
      const wrong = appWith({
        ingressAutoLoginHaAdmins: true,
        isHaAdmin: adminChecker(() => readAdminIds(url, "not-the-token")),
      });
      expect((await wrong.fetch(ingress("owner"))).status).toBe(403);
    } finally {
      core.stop(true);
    }
  });

  test("boot refuses auto_login_ha_admins without SUPERVISOR_TOKEN, and starts with it", () => {
    const good = { OWNER_PASSPHRASE: PASSPHRASE, API_TOKEN: "static-token-for-scripts" };
    expect(bootProblem({ ...good, INGRESS_AUTO_LOGIN_HA_ADMINS: "true" })).toMatch(/auto_login_ha_admins .* SUPERVISOR_TOKEN/);
    expect(bootProblem({ ...good, INGRESS_AUTO_LOGIN_HA_ADMINS: "true" })).not.toContain("\n");
    expect(bootProblem({ ...good, INGRESS_AUTO_LOGIN_HA_ADMINS: "true", SUPERVISOR_TOKEN: "s", DB_PATH: "/data/trace.db" })).toBeNull();
    expect(bootProblem({ ...good, INGRESS_AUTO_LOGIN_HA_ADMINS: "false" })).toBeNull();
    expect(bootProblem(good)).toBeNull();
  });

  test("the admin lookup's socket is not an env knob: no HA_CORE_WS_URL anywhere in src/", () => {
    // 1b-3 fix: the knob could never take effect (server.ts built the checker
    // only with SUPERVISOR_TOKEN, and boot refused the URL whenever that token
    // was set), so it was removed rather than made reachable. The fake Core
    // is exercised in-process above by handing createApp its own checker.
    const src = join(import.meta.dir, "..", "src");
    for (const file of readdirSync(src).filter((f) => f.endsWith(".ts"))) {
      expect({ file, mentions: readFileSync(join(src, file), "utf8").includes("HA_CORE_WS_URL") }).toEqual({ file, mentions: false });
    }
  });

  test("a real credential still wins over ingress, and /api/health reports the ingress door", async () => {
    const app = appWith({ apiToken: "static-token-for-scripts", ingressAutoLoginHaAdmins: true, ingressAutoLoginHaUserIds: ["other"] });
    // The bearer wins even though the ingress identity would be denied.
    const request = ingress("nat", { authorization: "Bearer static-token-for-scripts" }, "/api/health");
    const response = await app.fetch(request);
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).auth).toContain("ingress");
    expect(callerOf(request)?.method).toBe("api-token");
  });
});

describe("CORS preflight (1b-2 open item)", () => {
  test("allow-headers lists mcp-protocol-version, mcp-method and mcp-name on every path a 2026-07-28 browser client hits", async () => {
    const app = appWith({});
    for (const path of ["/mcp", "/api/nodes", "/.well-known/oauth-authorization-server", "/api/trace"]) {
      const response = await app.fetch(
        new Request(`http://localhost${path}`, {
          method: "OPTIONS",
          headers: {
            origin: "https://claude.ai",
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization, content-type, mcp-protocol-version, mcp-method, mcp-name",
          },
        }),
      );
      expect({ path, status: response.status }).toEqual({ path, status: 204 });
      const allowed = (response.headers.get("access-control-allow-headers") ?? "").split(",").map((h) => h.trim().toLowerCase());
      for (const header of ["authorization", "content-type", "mcp-protocol-version", "mcp-method", "mcp-name"]) {
        expect({ path, header, allowed: allowed.includes(header) }).toEqual({ path, header, allowed: true });
      }
      expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
  });
});
