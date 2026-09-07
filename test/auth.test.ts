/**
 * Authentication, end to end, against in-memory SQLite.
 *
 * The single most important assertion in this file is "the gate reaches routes
 * declared in the PARENT app". An Elysia lifecycle hook registered inside a
 * plugin is local by default: it would guard the plugin's own OAuth endpoints —
 * which need no guarding — and leave /mcp and every /api route wide open, with
 * no error anywhere and every other test in this file still passing. That is
 * the failure this suite exists to make impossible.
 *
 * Everything else here is the OAuth flow's refusals. The happy path is one
 * test; the other fifteen are the ways a client must NOT be able to get in,
 * because in an authorization server the refusals are the product.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createApp } from "../src/app";
import type { AuthConfig } from "../src/auth";
import { isPublicPath } from "../src/auth-plugin";
import { openSqliteStore } from "../src/store/sqlite";
import type { Store } from "../src/store/types";
import { lockoutSeconds } from "../src/ratelimit";
import { sha256Base64Url } from "../src/utils";

// Read from disk, not hardcoded — see the note in app.test.ts.
const migrations = readdirSync(join(import.meta.dir, "..", "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({ name: file, sql: readFileSync(join(import.meta.dir, "..", "migrations", file), "utf8") }));

const PASSPHRASE = "open-sesame-please";
const API_TOKEN = "static-token-for-scripts";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let store: Store;

/** A fresh app with whatever credentials the test needs. */
const appWith = (auth: AuthConfig) => createApp({ store, instanceName: "test", auth });

const formTo = (path: string, fields: Record<string, string>) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

const registerClient = async (
  app: ReturnType<typeof createApp>,
  redirectUris: string[] = [REDIRECT],
) => {
  const response = await app.fetch(
    new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: redirectUris }),
    }),
  );
  return { status: response.status, body: (await response.json()) as any };
};

/** Drive the whole dance and hand back a usable access token. */
const fullFlow = async (app: ReturnType<typeof createApp>) => {
  const { body: client } = await registerClient(app);
  const verifier = "a-verifier-long-enough-to-be-real-43-chars-min";
  const challenge = await sha256Base64Url(verifier);

  const approved = await app.fetch(
    formTo("/authorize", {
      passphrase: PASSPHRASE,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      state: "xyz",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "nodes:read nodes:write",
      resource: "http://localhost/mcp",
    }),
  );
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

  const token = await app.fetch(
    formTo("/oauth/token", {
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  );
  return { client, verifier, challenge, code, token: (await token.json()) as any };
};

beforeEach(async () => {
  store = await openSqliteStore(":memory:", migrations);
});

describe("open by default", () => {
  test("with no secrets set, everything answers exactly as before", async () => {
    const app = appWith({});
    expect((await app.fetch(new Request("http://localhost/api/nodes"))).status).toBe(200);

    const health = (await (await app.fetch(new Request("http://localhost/api/health"))).json()) as any;
    // Not `false`, not omitted — the word, so an operator reading /api/health
    // once knows the corpus is public without having to reason about it.
    expect(health.auth).toBe("none");
  });
});

describe("the gate", () => {
  /**
   * THE scope test. If the plugin's onBeforeHandle were locally scoped this
   * would return 200 and every other test here would still pass.
   */
  test("reaches routes declared in the parent app, not just the plugin's own", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    for (const path of ["/api/nodes", "/api/stats", "/api/tools", "/api/vocabularies"]) {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
  });

  test("guards /mcp, which is the whole point", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    const response = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  test("the 401 points at the resource metadata, which is how a client finds OAuth", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const response = await app.fetch(new Request("http://localhost/api/nodes"));
    const header = response.headers.get("www-authenticate") ?? "";
    expect(header).toContain("Bearer");
    expect(header).toContain(
      'resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"',
    );
    // The scope a client should ask for, in the challenge itself — it should
    // not have to fetch the metadata document to learn what to request.
    expect(header).toContain('scope="nodes:read nodes:write"');
    expect(header).toContain('error="invalid_token"');
    // A browser client that cannot READ the header learns nothing from it.
    expect(response.headers.get("access-control-expose-headers")).toContain("www-authenticate");
  });

  test("leaves discovery, health and the page reachable without a credential", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    for (const path of [
      "/health",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/",
    ]) {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
    }
  });

  test("serves the lock screen at / rather than a blank 401", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const html = await (await app.fetch(new Request("http://localhost/"))).text();
    expect(html).toContain("Owner passphrase");
    // The corpus UI must not be behind it.
    expect(html).not.toContain("tag cloud");
  });

  test("health names which doors are open, not merely that some are", async () => {
    // On /api/health, with a credential (PRD §3.3): the public /health no
    // longer says which doors exist.
    const authed = { authorization: `Bearer ${API_TOKEN}` };
    const both = appWith({ ownerPassphrase: PASSPHRASE, apiToken: API_TOKEN });
    const health = (await (await both.fetch(new Request("http://localhost/api/health", { headers: authed }))).json()) as any;
    expect(health.auth).toEqual(["api-token", "oauth", "owner-session"]);

    const tokenOnly = appWith({ apiToken: API_TOKEN });
    const other = (await (await tokenOnly.fetch(new Request("http://localhost/api/health", { headers: authed }))).json()) as any;
    // Says "oauth" is NOT available — a claude.ai user needs to know this
    // before spending ten minutes on a connector that cannot work.
    expect(other.auth).toEqual(["api-token"]);

    // And the public probe carries none of it.
    const pub = (await (await both.fetch(new Request("http://localhost/health"))).json()) as any;
    expect(Object.keys(pub).sort()).toEqual(["ok", "server", "version"]);
    expect(pub.server).toBe("trace-node");
  });
});

describe("static bearer", () => {
  test("opens the gate", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    const response = await app.fetch(
      new Request("http://localhost/api/nodes", {
        headers: { authorization: `Bearer ${API_TOKEN}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  test("accepts a lowercase scheme, which RFC 7235 says is legal", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    const response = await app.fetch(
      new Request("http://localhost/api/nodes", {
        headers: { authorization: `bearer ${API_TOKEN}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  test("refuses a wrong token, a prefix of the right one, and a bare token", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    for (const header of [
      "Bearer wrong",
      `Bearer ${API_TOKEN.slice(0, -1)}`,
      API_TOKEN,
      "Basic dXNlcjpwYXNz",
    ]) {
      const response = await app.fetch(
        new Request("http://localhost/api/nodes", { headers: { authorization: header } }),
      );
      expect({ header, status: response.status }).toEqual({ header, status: 401 });
    }
  });
});

describe("discovery documents", () => {
  test("issuer equals the origin the client actually reached", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const body = (await (
      await app.fetch(new Request("http://localhost/.well-known/oauth-authorization-server"))
    ).json()) as any;

    // The trap this project inherited: a mismatch here fails every OAuth client
    // silently while the static-token path keeps working.
    expect(body.issuer).toBe("http://localhost");
    expect(body.authorization_endpoint).toBe("http://localhost/authorize");
    expect(body.token_endpoint).toBe("http://localhost/oauth/token");
    expect(body.registration_endpoint).toBe("http://localhost/oauth/register");
    // S256 only — advertising "plain" invites a client to use it.
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
  });

  /**
   * A client that 404s on the RFC 8414 path is required to try this one next,
   * and a client that 404s twice stops. Serving the identical body at both URLs
   * is the cheapest insurance against a discovery chain that dead-ends.
   */
  test("the OIDC discovery alias serves the identical document", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const [rfc8414, oidc] = await Promise.all(
      [
        "/.well-known/oauth-authorization-server",
        "/.well-known/openid-configuration",
      ].map(async (path) => (await app.fetch(new Request(`http://localhost${path}`))).json()),
    );
    expect(oidc).toEqual(rfc8414);
  });

  test("the authorization redirect carries iss, so a client can tell which AS answered", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const response = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url("some-verifier"),
        code_challenge_method: "S256",
      }),
    );
    const location = new URL(response.headers.get("location")!);
    // Byte-identical to the metadata `issuer` — clients compare without
    // normalising, so a trailing slash here would fail the check.
    expect(location.searchParams.get("iss")).toBe("http://localhost");
  });

  test("the protected resource is the MCP endpoint, not the origin", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const body = (await (
      await app.fetch(new Request("http://localhost/.well-known/oauth-protected-resource/mcp"))
    ).json()) as any;
    expect(body.resource).toBe("http://localhost/mcp");
    expect(body.authorization_servers).toEqual(["http://localhost"]);
  });

  test("PUBLIC_URL overrides the derived origin, exactly and without a trailing slash", async () => {
    const app = createApp({
      store,
      instanceName: "test",
      auth: { ownerPassphrase: PASSPHRASE },
      publicUrl: "https://trace-node.example.com/",
    });
    const body = (await (
      await app.fetch(new Request("http://localhost/.well-known/oauth-authorization-server"))
    ).json()) as any;
    expect(body.issuer).toBe("https://trace-node.example.com");
    expect(body.authorization_endpoint).toBe("https://trace-node.example.com/authorize");
  });
});

describe("dynamic client registration", () => {
  test("registers a client and issues no secret", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { status, body } = await registerClient(app);
    expect(status).toBe(201);
    expect(body.client_id).toBeTruthy();
    expect(body.redirect_uris).toEqual([REDIRECT]);
    expect(body.token_endpoint_auth_method).toBe("none");
    // A public client cannot keep a secret; PKCE is what binds the code to it.
    expect(body.client_secret).toBeUndefined();
  });

  test("requires at least one redirect_uri", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { status, body } = await registerClient(app, []);
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_client_metadata");
  });

  test("refuses plaintext http off loopback, and allows it on", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    expect((await registerClient(app, ["http://evil.example.com/cb"])).status).toBe(400);
    // A local MCP client completing the flow on the user's own machine.
    expect((await registerClient(app, ["http://localhost:7777/callback"])).status).toBe(201);
  });

  test("refuses a redirect_uri with a fragment, which the browser would drop", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    expect((await registerClient(app, ["https://x.example.com/cb#frag"])).status).toBe(400);
  });

  test("says 501, not 404, when OAuth is unconfigured", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    const { status, body } = await registerClient(app);
    // The endpoint exists and is switched off. That is a different problem for
    // whoever is debugging than a wrong URL, and must not read as one.
    expect(status).toBe(501);
    expect(body.error).toBe("oauth_not_configured");
  });

  /**
   * The redirect-host allowlist (PRD §3.9 #5). digger accepted any https host,
   * so `{client_name:"claude.ai", redirect_uris:["https://evil/cb"]}` plus one
   * link to /authorize minted the attacker a 30-day token off the owner's
   * passphrase, on a consent page that printed only the attacker's chosen name.
   */
  test("DCR with https://evil/cb → 400 invalid_redirect_uri, and the consent page names the redirect host", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const evil = await app.fetch(
      new Request("http://localhost/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "claude.ai", redirect_uris: ["https://evil/cb"] }),
      }),
    );
    expect(evil.status).toBe(400);
    expect(evil.headers.get("cache-control")).toBe("no-store");
    expect(((await evil.json()) as any).error).toBe("invalid_redirect_uri");
    // A host that merely CONTAINS an allowed name is not allowed either.
    expect((await registerClient(app, ["https://notclaude.ai/cb"])).status).toBe(400);
    // The real one still registers, and the page says where the code will go.
    const { status, body: client } = await registerClient(app);
    expect(status).toBe(201);
    const html = await (
      await app.fetch(
        new Request(
          `http://localhost/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
            `&code_challenge=xyz&code_challenge_method=S256&scope=nodes%3Aread%20traces%3Aread`,
        ),
      )
    ).text();
    expect(html).toContain("claude.ai");
    expect(html).toContain(client.client_id.slice(0, 8));
    // traces:read is never carried forward silently — only the checkbox grants it.
    expect(html).toContain('name="scope" value="nodes:read"');
    expect(html).toContain('name="traces_read"');
  });
});

describe("the authorization dance", () => {
  test("register, approve, exchange, and the token opens the corpus", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { token } = await fullFlow(app);

    expect(token.token_type).toBe("Bearer");
    expect(token.access_token).toBeTruthy();
    expect(token.expires_in).toBeGreaterThan(0);
    // No refresh token is issued, and none is implied.
    expect(token.refresh_token).toBeUndefined();

    const authed = await app.fetch(
      new Request("http://localhost/api/nodes", {
        headers: { authorization: `Bearer ${token.access_token}` },
      }),
    );
    expect(authed.status).toBe(200);

    // And the same token drives MCP, which is the entire purpose.
    const mcp = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(mcp.status).toBe(200);
    expect(((await mcp.json()) as any).result.tools.length).toBeGreaterThan(10);
  });

  test("echoes state back on the redirect — it is the client's CSRF defence", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const response = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        state: "the-clients-nonce",
        code_challenge: await sha256Base64Url("v".repeat(50)),
        code_challenge_method: "S256",
        scope: "nodes:read",
      }),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("the-clients-nonce");
    expect(location.searchParams.get("code")).toBeTruthy();
  });

  test("the consent page renders and carries every parameter forward", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const url =
      `http://localhost/authorize?client_id=${client.client_id}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=abc` +
      `&code_challenge=xyz&code_challenge_method=S256&scope=nodes%3Aread`;
    const html = await (await app.fetch(new Request(url))).text();

    expect(html).toContain("Owner passphrase");
    expect(html).toContain('name="state" value="abc"');
    expect(html).toContain('name="code_challenge" value="xyz"');
    // Without these hidden fields the POST cannot issue a code at all.
    expect(html).toContain(`name="client_id" value="${client.client_id}"`);
  });
});

describe("the refusals", () => {
  test("a wrong passphrase issues no code and does not redirect", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const response = await app.fetch(
      formTo("/authorize", {
        passphrase: "not-it",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url("verifier"),
        code_challenge_method: "S256",
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("does not match");
  });

  /**
   * The open redirect. A client registered for one callback must not be able to
   * receive a code at another, and the failure must land on OUR page — bouncing
   * the browser to the attacker's URL to tell it "no" is the vulnerability.
   */
  test("an unregistered redirect_uri fails on our own page, never as a redirect", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);

    for (const evil of [
      "https://claude.ai.attacker.example/cb",
      `${REDIRECT}.attacker.example`,
      `${REDIRECT}/../elsewhere`,
      "https://claude.ai/api/mcp/auth_callback2",
    ]) {
      const get = await app.fetch(
        new Request(
          `http://localhost/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(evil)}`,
        ),
      );
      expect({ evil, status: get.status, location: get.headers.get("location") }).toEqual({
        evil,
        status: 400,
        location: null,
      });

      const post = await app.fetch(
        formTo("/authorize", {
          passphrase: PASSPHRASE,
          client_id: client.client_id,
          redirect_uri: evil,
          code_challenge: await sha256Base64Url("verifier"),
          code_challenge_method: "S256",
        }),
      );
      expect(post.status).toBe(400);
      expect(post.headers.get("location")).toBeNull();
    }
  });

  test("an unknown client_id is refused", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const response = await app.fetch(
      new Request(
        `http://localhost/authorize?client_id=never-registered&redirect_uri=${encodeURIComponent(REDIRECT)}`,
      ),
    );
    expect(response.status).toBe(400);
  });

  test("code_challenge_method=plain is refused outright", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const response = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: "whatever",
        code_challenge_method: "plain",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("S256");
  });

  test("a missing code_challenge is refused — PKCE is not optional here", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const response = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: "",
        code_challenge_method: "S256",
      }),
    );
    expect(response.status).toBe(400);
  });

  test("the wrong verifier does not exchange", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const approved = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url("the-real-verifier"),
        code_challenge_method: "S256",
      }),
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

    const response = await app.fetch(
      formTo("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: "a-different-verifier",
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error).toBe("invalid_grant");
  });

  /**
   * A failed exchange must BURN the code too. Otherwise an attacker holding an
   * intercepted code gets unlimited attempts at guessing the verifier, which is
   * exactly what PKCE exists to prevent.
   */
  test("a code is single-use, and a failed attempt spends it", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const verifier = "the-real-verifier-value-here";
    const approved = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url(verifier),
        code_challenge_method: "S256",
      }),
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

    const wrong = await app.fetch(
      formTo("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: "wrong",
      }),
    );
    expect(wrong.status).toBe(400);

    // The right verifier now fails too — the code was spent by the attempt.
    const retry = await app.fetch(
      formTo("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
    );
    expect(retry.status).toBe(400);
    expect(((await retry.json()) as any).error).toBe("invalid_grant");
  });

  test("a code issued to one client cannot be redeemed by another", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: victim } = await registerClient(app);
    // Loopback: the redirect-host allowlist (PRD §3.9 #5) refuses an arbitrary
    // https host at registration, which would leave this test with no second
    // client at all — the property under test is the code binding, not the host.
    const attackerRegistered = await registerClient(app, ["http://127.0.0.1:9/cb"]);
    expect(attackerRegistered.status).toBe(201);
    const attacker = attackerRegistered.body;
    const verifier = "shared-verifier-value";

    const approved = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: victim.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url(verifier),
        code_challenge_method: "S256",
      }),
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

    const stolen = await app.fetch(
      formTo("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: attacker.client_id,
        redirect_uri: "http://127.0.0.1:9/cb",
        code_verifier: verifier,
      }),
    );
    expect(stolen.status).toBe(400);
  });

  test("an unsupported grant_type is named as such", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const response = await app.fetch(
      formTo("/oauth/token", { grant_type: "client_credentials" }),
    );
    expect(((await response.json()) as any).error).toBe("unsupported_grant_type");
  });

  test("every token failure returns the same opaque error", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const bodies = await Promise.all(
      [
        { grant_type: "authorization_code", code: "nonexistent" },
        { grant_type: "authorization_code", code: "", client_id: "x" },
      ].map(async (fields) =>
        ((await (await app.fetch(formTo("/oauth/token", fields as any))).json()) as any).error,
      ),
    );
    // Telling a caller WHICH check failed hands it a probing oracle.
    expect(new Set(bodies)).toEqual(new Set(["invalid_grant"]));
  });
});

describe("credentials at rest", () => {
  /**
   * The token IS the secret, so a row holding one is as sensitive as the session
   * it opens. Any read of this database — a console session, a backup, an
   * injection in some unrelated query — would otherwise hand over credentials
   * that replay directly against /mcp.
   */
  test("the database stores a digest, never a usable token", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { token } = await fullFlow(app);

    const rows = await store.all<{ token_hash: string }>("SELECT token_hash FROM oauth_tokens");
    expect(rows.length).toBe(1);
    expect(rows[0].token_hash).not.toBe(token.access_token);
    expect(rows[0].token_hash).toBe(await sha256Base64Url(token.access_token));

    // And the plaintext appears nowhere else in the table.
    const dump = JSON.stringify(await store.all("SELECT * FROM oauth_tokens"));
    expect(dump).not.toContain(token.access_token);
  });

  test("an authorization code is stored as a digest too", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const approved = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url("verifier"),
        code_challenge_method: "S256",
      }),
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

    const rows = await store.all<{ code_hash: string }>("SELECT code_hash FROM oauth_codes");
    expect(rows[0].code_hash).toBe(await sha256Base64Url(code));
    expect(rows[0].code_hash).not.toBe(code);
  });

  /**
   * The corollary worth asserting: hashing must not have broken the lookup. A
   * digest stored and a plaintext queried would fail closed — safe, and totally
   * useless — so the happy path is re-checked here from the other direction.
   */
  test("a stolen digest cannot be presented as a token", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { token } = await fullFlow(app);
    const digest = await sha256Base64Url(token.access_token);

    const stolen = await app.fetch(
      new Request("http://localhost/api/nodes", { headers: { authorization: `Bearer ${digest}` } }),
    );
    expect(stolen.status).toBe(401);
  });
});

describe("token audience", () => {
  /**
   * RFC 8707. Fail OPEN on absence and CLOSED on mismatch: not every client
   * sends `resource`, and refusing those would lock out clients behaving
   * legally — but one that told us what the token was for does not get to use
   * it somewhere else.
   */
  test("a token recorded for another resource does not open this one", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const verifier = "verifier-for-the-audience-test";

    const approved = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url(verifier),
        code_challenge_method: "S256",
        resource: "https://some-other-server.example/mcp",
      }),
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const issued = (await (
      await app.fetch(
        formTo("/oauth/token", {
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }),
      )
    ).json()) as any;

    // The exchange succeeds — the token is real, just not for here.
    expect(issued.access_token).toBeTruthy();
    const response = await app.fetch(
      new Request("http://localhost/api/nodes", {
        headers: { authorization: `Bearer ${issued.access_token}` },
      }),
    );
    expect(response.status).toBe(401);
  });

  test("a token with no recorded resource is accepted", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const verifier = "verifier-with-no-resource";

    const approved = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url(verifier),
        code_challenge_method: "S256",
        // no `resource` at all — the client never sent one
      }),
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const issued = (await (
      await app.fetch(
        formTo("/oauth/token", {
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }),
      )
    ).json()) as any;

    const response = await app.fetch(
      new Request("http://localhost/api/nodes", {
        headers: { authorization: `Bearer ${issued.access_token}` },
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe("rate limiting the passphrase", () => {
  /**
   * The passphrase is the only credential here a human chose, so it is the only
   * one short enough to guess. Everything else has 32 bytes of entropy behind
   * it. These tests are about the guessing budget, not the comparison.
   *
   * The bucket is keyed on the socket peer server.ts stamps (`x-trace-peer-ip`),
   * never on a header the client can write (PRD §3.9 #2).
   */
  const guess = (
    app: ReturnType<typeof createApp>,
    passphrase: string,
    ip = "203.0.113.7",
  ) =>
    app.fetch(
      new Request("http://localhost/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-trace-peer-ip": ip,
        },
        body: new URLSearchParams({ passphrase }).toString(),
      }),
    );

  test("five wrong guesses are allowed, the sixth is throttled", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    for (let i = 1; i <= 5; i++) {
      expect({ attempt: i, status: (await guess(app, "wrong")).status }).toEqual({
        attempt: i,
        status: 401,
      });
    }
    const sixth = await guess(app, "wrong");
    expect(sixth.status).toBe(429);
    // RFC 9110: seconds, and a client that honours it needs it present.
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await sixth.text()).toContain("Too many failed attempts");
  });

  /**
   * The throttle gates the ATTEMPT, not the verdict. Letting a locked-out caller
   * through on a correct guess would tell them the moment they hit it, and the
   * lockout would have protected nothing.
   */
  test("a throttled caller is refused even with the CORRECT passphrase", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    for (let i = 0; i < 5; i++) await guess(app, "wrong");

    const right = await guess(app, PASSPHRASE);
    expect(right.status).toBe(429);
    expect(right.headers.get("set-cookie")).toBeNull();
  });

  test("the budget is per address, and per door", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    for (let i = 0; i < 5; i++) await guess(app, "wrong", "198.51.100.1");
    expect((await guess(app, "wrong", "198.51.100.1")).status).toBe(429);

    // A different address still has its full budget — one attacker must not be
    // able to lock the owner out.
    expect((await guess(app, "wrong", "198.51.100.99")).status).toBe(401);

    // And /authorize is a separate bucket: hammering /login does not close it.
    const { body: client } = await registerClient(app);
    const consent = await app.fetch(
      new Request("http://localhost/authorize", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-trace-peer-ip": "198.51.100.1",
        },
        body: new URLSearchParams({
          passphrase: "wrong",
          client_id: client.client_id,
          redirect_uri: REDIRECT,
          code_challenge: await sha256Base64Url("v"),
          code_challenge_method: "S256",
        }).toString(),
      }),
    );
    expect(consent.status).toBe(401);
  });

  test("a correct passphrase clears the record", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const ip = "203.0.113.200";
    for (let i = 0; i < 4; i++) await guess(app, "wrong", ip);
    expect((await guess(app, PASSPHRASE, ip)).status).toBe(302);

    // Four failures then a success must not leave one guess in the tank.
    expect((await store.all("SELECT * FROM auth_attempts")).length).toBe(0);
  });

  test("the backoff doubles and is capped, so waiting always works", async () => {
    expect(lockoutSeconds(4)).toBe(0);
    expect(lockoutSeconds(5)).toBe(120);
    expect(lockoutSeconds(6)).toBe(240);
    expect(lockoutSeconds(7)).toBe(480);
    // Capped — a mistake is recoverable by waiting, never only by redeploying.
    expect(lockoutSeconds(50)).toBe(3600);
  });

  test("it is optional, and /health says which", async () => {
    const off = createApp({ store, instanceName: "test", auth: { ownerPassphrase: PASSPHRASE }, rateLimit: false });
    for (let i = 0; i < 8; i++) {
      expect(
        (
          await off.fetch(
            new Request("http://localhost/login", {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                "x-trace-peer-ip": "203.0.113.99",
              },
              body: new URLSearchParams({ passphrase: "wrong" }).toString(),
            }),
          )
        ).status,
      ).toBe(401);
    }
    expect((await store.all("SELECT * FROM auth_attempts")).length).toBe(0);

    // /api/health, with a credential: a cookie minted by the passphrase, or
    // nothing on the open server (PRD §3.3).
    const health = async (app: ReturnType<typeof createApp>) => {
      const login = await app.fetch(formTo("/login", { passphrase: PASSPHRASE }));
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
      const response = await app.fetch(new Request("http://localhost/api/health", { headers: { cookie } }));
      return ((await response.json()) as any).rate_limit;
    };
    expect(await health(off)).toBe(false);
    expect(await health(appWith({ ownerPassphrase: PASSPHRASE }))).toBe(true);
    // An open server has no passphrase to protect, so there is nothing to say.
    expect(await health(createApp({ store, instanceName: "test" }))).toBeNull();
  });
});

/**
 * The key is the peer, not a header (PRD §3.9 #2, #11).
 *
 * digger keyed on `cf-connecting-ip` first, which off Cloudflare is whatever
 * the client sent — a fresh header per request bought a fresh five-guess budget
 * per request, worse than one shared bucket because it looked fixed. Forwarded
 * headers are believed only from a `trusted_proxies` peer.
 */
describe("peer-keyed throttles", () => {
  const loginAs = (
    app: ReturnType<typeof createApp>,
    headers: Record<string, string>,
    passphrase = "wrong",
  ) =>
    app.fetch(
      new Request("http://localhost/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams({ passphrase }).toString(),
      }),
    );

  test("a forged cf-connecting-ip from 10.0.0.9 shares the 10.0.0.9 bucket; the 6th failure is 429", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    for (let i = 1; i <= 5; i++) {
      // A fresh forged header every time — the attack the old key rewarded.
      const res = await loginAs(app, { "x-trace-peer-ip": "10.0.0.9", "cf-connecting-ip": `203.0.113.${i}` });
      expect({ attempt: i, status: res.status }).toEqual({ attempt: i, status: 401 });
    }
    const sixth = await loginAs(app, { "x-trace-peer-ip": "10.0.0.9", "cf-connecting-ip": "203.0.113.6" });
    expect(sixth.status).toBe(429);
    // One bucket, and it is the peer's.
    const rows = await store.all<{ client_ip: string; failures: number }>("SELECT client_ip, failures FROM auth_attempts");
    expect(rows).toEqual([{ client_ip: "10.0.0.9", failures: 5 }]);
  });

  test("a trusted_proxies peer + header uses the header", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, trustedProxies: ["10.0.0.1"] });
    for (let i = 0; i < 5; i++) {
      await loginAs(app, { "x-trace-peer-ip": "10.0.0.1", "cf-connecting-ip": "203.0.113.5" });
    }
    // Same forwarded client: locked out.
    expect((await loginAs(app, { "x-trace-peer-ip": "10.0.0.1", "cf-connecting-ip": "203.0.113.5" })).status).toBe(429);
    // A different client behind the same trusted proxy still has its budget.
    expect((await loginAs(app, { "x-trace-peer-ip": "10.0.0.1", "cf-connecting-ip": "203.0.113.6" })).status).toBe(401);
    // And the same header from an UNTRUSTED peer is ignored — that peer's own bucket.
    expect((await loginAs(app, { "x-trace-peer-ip": "10.0.0.2", "cf-connecting-ip": "203.0.113.5" })).status).toBe(401);
  });

  test("the 51st bad Bearer in 15 min from one peer is 429", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    const bad = () =>
      app.fetch(
        new Request("http://localhost/api/nodes", {
          headers: { authorization: "Bearer not-the-token", "x-trace-peer-ip": "10.0.0.9" },
        }),
      );
    for (let i = 1; i <= 50; i++) {
      expect({ attempt: i, status: (await bad()).status }).toEqual({ attempt: i, status: 401 });
    }
    const throttled = await bad();
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
    // The lockout gates the ATTEMPT: even the right token waits it out.
    const right = await app.fetch(
      new Request("http://localhost/api/nodes", {
        headers: { authorization: `Bearer ${API_TOKEN}`, "x-trace-peer-ip": "10.0.0.9" },
      }),
    );
    expect(right.status).toBe(429);
    // Another peer is unaffected.
    const other = await app.fetch(
      new Request("http://localhost/api/nodes", {
        headers: { authorization: `Bearer ${API_TOKEN}`, "x-trace-peer-ip": "10.0.0.10" },
      }),
    );
    expect(other.status).toBe(200);
  });
});

describe("changing the lock", () => {
  const login = (app: ReturnType<typeof createApp>, passphrase: string) =>
    app.fetch(formTo("/login", { passphrase }));
  const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0];

  // `x-trace-client: ui` — the CSRF rule of PRD §3.10 (c) applies to
  // POST /api/passphrase; the page sends it on every request (pre-ruling 1).
  const change = (app: ReturnType<typeof createApp>, cookie: string, current: string, next: string) =>
    app.fetch(new Request("http://localhost/api/passphrase", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-trace-client": "ui" },
      body: JSON.stringify({ current, next }),
    }));

  test("a new passphrase works and the old one stops", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));

    const res = await change(app, cookie, PASSPHRASE, "a-memorable-one");
    expect(res.status).toBe(200);

    expect((await login(app, "a-memorable-one")).status).toBe(302);
    expect((await login(app, PASSPHRASE)).status).toBe(302); // env secret still opens it — recovery
  });

  /**
   * The recovery path is deliberate, not an oversight: forgetting what you typed
   * into the UI must not be equivalent to losing the corpus. The deployed secret
   * always works, from a machine you control.
   */
  test("the deployed secret remains a recovery path after a change", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));
    await change(app, cookie, PASSPHRASE, "something-else-entirely");
    expect((await login(app, PASSPHRASE)).status).toBe(302);
  });

  test("the current passphrase is required even with a live session", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));
    // A live session proves someone got in once, not that they are the owner
    // now — and changing the lock is exactly what a hijacked session would want.
    const res = await change(app, cookie, "not-the-current-one", "brand-new-value");
    expect(res.status).toBe(401);
    expect((await login(app, "brand-new-value")).status).toBe(401);
  });

  test("a too-short passphrase is refused with the reason", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));
    const res = await change(app, cookie, PASSPHRASE, "short");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).message).toContain("at least");
  });

  test("changing the lock signs OTHER sessions out", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const other = cookieOf(await login(app, PASSPHRASE));
    const mine = cookieOf(await login(app, PASSPHRASE));

    expect((await app.fetch(new Request("http://localhost/api/nodes", { headers: { cookie: other } }))).status).toBe(200);

    const res = await change(app, mine, PASSPHRASE, "the-new-lock-value");
    // The session that made the change is re-issued, so you are not locked out
    // of the browser you just used.
    const reissued = cookieOf(res);
    expect(reissued).toContain("trace_session=");
    expect((await app.fetch(new Request("http://localhost/api/nodes", { headers: { cookie: reissued } }))).status).toBe(200);

    // Every other device is out.
    expect((await app.fetch(new Request("http://localhost/api/nodes", { headers: { cookie: other } }))).status).toBe(401);
  });

  test("the stored passphrase is never readable, only its existence", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));
    // The change rotates the session key, so it hands back a re-issued cookie.
    // Carrying the old one forward is exactly the mistake a client would make.
    const fresh = cookieOf(await change(app, cookie, PASSPHRASE, "a-memorable-one"));

    const rows = await store.all<{ value: string }>("SELECT value FROM settings");
    expect(rows[0].value).not.toContain("a-memorable-one");
    // PBKDF2, not a bare digest: a passphrase chosen to be REMEMBERED falls to a
    // wordlist against sha256, which is why this file is not sha256Base64Url.
    expect(rows[0].value).toMatch(/^pbkdf2\$\d+\$/);

    const shown = (await (await app.fetch(new Request("http://localhost/api/passphrase", { headers: { cookie: fresh } }))).json()) as any;
    // 12, not digger's 8 (PRD §2 Passphrase row, §6.3).
    expect(shown).toEqual({ stored: true, min_length: 12 });
  });

  test("the cookie that made the change is the only one that still works", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));
    const fresh = cookieOf(await change(app, cookie, PASSPHRASE, "a-memorable-one"));

    expect((await app.fetch(new Request("http://localhost/api/passphrase", { headers: { cookie } }))).status).toBe(401);
    expect((await app.fetch(new Request("http://localhost/api/passphrase", { headers: { cookie: fresh } }))).status).toBe(200);
  });

  /**
   * Rotation keeps the claude.ai grant (PRD §3.9 #10). `verifyBearer` is a pure
   * token_hash lookup; only the session HMAC key folds the stored hash. So a
   * new passphrase signs every browser out and leaves every connector working —
   * "rotate = sessions out, connectors stay; revoke via DELETE /api/clients/:id".
   */
  test("changing the lock keeps OAuth tokens", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { token } = await fullFlow(app);
    const bearer = { authorization: `Bearer ${token.access_token}` };
    expect((await app.fetch(new Request("http://localhost/api/nodes", { headers: bearer }))).status).toBe(200);

    const cookie = cookieOf(await login(app, PASSPHRASE));
    expect((await change(app, cookie, PASSPHRASE, "a-brand-new-lock-value")).status).toBe(200);

    // The browser session that did not make the change is out...
    expect((await app.fetch(new Request("http://localhost/api/nodes", { headers: { cookie } }))).status).toBe(401);
    // ...and the connector's 30-day token is untouched.
    expect((await app.fetch(new Request("http://localhost/api/nodes", { headers: bearer }))).status).toBe(200);
    const mcp = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(mcp.status).toBe(200);
  });

  /**
   * A UI change is not a rotation (PRD §3.9 #10, §6.5): `checkOwner` accepts
   * the env value forever, so the add-on option keeps opening /login AND
   * /authorize until the option itself changes and the add-on restarts.
   */
  test("env passphrase still grants /authorize after a UI change", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));
    expect((await change(app, cookie, PASSPHRASE, "chosen-in-the-ui-later")).status).toBe(200);

    const { body: client } = await registerClient(app);
    const consent = (passphrase: string) =>
      app.fetch(
        formTo("/authorize", {
          passphrase,
          client_id: client.client_id,
          redirect_uri: REDIRECT,
          code_challenge: "Y2hhbGxlbmdl",
          code_challenge_method: "S256",
        }),
      );
    // The deployed secret still approves a connector...
    expect((await consent(PASSPHRASE)).status).toBe(302);
    // ...so does the one chosen in the UI, and a wrong one still does not.
    expect((await consent("chosen-in-the-ui-later")).status).toBe(302);
    expect((await consent("neither-of-them")).status).toBe(401);
  });

  test("reverting drops back to the deployed secret", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));
    const fresh = cookieOf(await change(app, cookie, PASSPHRASE, "a-memorable-one"));

    // Must use the re-issued cookie — the old one died with the old lock.
    // Same CSRF header as change(): a mutating /api/* call with a cookie.
    const reverted = await app.fetch(
      new Request("http://localhost/api/passphrase", {
        method: "DELETE",
        headers: { cookie: fresh, "x-trace-client": "ui" },
      }),
    );
    expect(reverted.status).toBe(200);
    expect((await login(app, "a-memorable-one")).status).toBe(401);
    expect((await login(app, PASSPHRASE)).status).toBe(302);
  });
});

describe("revocation", () => {
  test("revoking a client kills its live token immediately", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { client, token } = await fullFlow(app);
    const authorized = { authorization: `Bearer ${token.access_token}` };

    expect((await app.fetch(new Request("http://localhost/api/nodes", { headers: authorized }))).status).toBe(200);

    const listed = (await (
      await app.fetch(new Request("http://localhost/api/clients", { headers: authorized }))
    ).json()) as any;
    expect(listed.clients[0].active_tokens).toBe(1);

    await app.fetch(
      new Request(`http://localhost/api/clients/${client.client_id}`, {
        method: "DELETE",
        headers: authorized,
      }),
    );

    // No cache to wait out: verification reads the table on every request.
    expect((await app.fetch(new Request("http://localhost/api/nodes", { headers: authorized }))).status).toBe(401);
  });

  test("the client list is behind the gate — it names who can reach the corpus", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    expect((await app.fetch(new Request("http://localhost/api/clients"))).status).toBe(401);
  });

  /**
   * The CSRF rule (PRD §3.10 c). A cookie rides along with whatever the browser
   * sends, including a form a co-resident add-on's page submits on the same HA
   * origin. A mutating /api/* call with a cookie must carry `X-Trace-Client: ui`
   * — a header a cross-site form cannot set. Bearer callers are exempt.
   */
  test("DELETE /api/clients/:id with a cookie and no X-Trace-Client → 403; with it, or with a Bearer, it works", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, apiToken: API_TOKEN });
    const { client } = await fullFlow(app);
    const login = await app.fetch(formTo("/login", { passphrase: PASSPHRASE }));
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const target = `http://localhost/api/clients/${client.client_id}`;

    const forged = await app.fetch(new Request(target, { method: "DELETE", headers: { cookie } }));
    expect(forged.status).toBe(403);
    // Reads with a cookie are unaffected — only mutations need the header.
    expect((await app.fetch(new Request("http://localhost/api/clients", { headers: { cookie } }))).status).toBe(200);
    // A Bearer header cannot be forged cross-site, so it needs no second header.
    expect(
      (await app.fetch(new Request(target, { method: "DELETE", headers: { authorization: `Bearer ${API_TOKEN}` } }))).status,
    ).toBe(200);
    const page = await app.fetch(new Request(target, { method: "DELETE", headers: { cookie, "x-trace-client": "ui" } }));
    expect(page.status).toBe(200);
  });
});

describe("the browser session", () => {
  const cookieFrom = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0];

  test("a correct passphrase mints a cookie that opens the corpus", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const login = await app.fetch(formTo("/login", { passphrase: PASSPHRASE }));
    expect(login.status).toBe(302);

    const cookie = cookieFrom(login);
    expect(cookie).toContain("trace_session=");
    const raw = login.headers.get("set-cookie")!;
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
    // Not Secure here: this request arrived over http, and marking it Secure
    // would make the browser silently drop it — a correct passphrase that
    // lands back on the lock screen.
    expect(raw).not.toContain("Secure");

    const response = await app.fetch(new Request("http://localhost/api/nodes", { headers: { cookie } }));
    expect(response.status).toBe(200);
  });

  test("marks the cookie Secure when the request arrived over TLS", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const login = await app.fetch(
      new Request("https://example.com/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ passphrase: PASSPHRASE }).toString(),
      }),
    );
    expect(login.headers.get("set-cookie")).toContain("Secure");
  });

  test("a wrong passphrase mints nothing", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const login = await app.fetch(formTo("/login", { passphrase: "nope" }));
    expect(login.status).toBe(401);
    expect(login.headers.get("set-cookie")).toBeNull();
  });

  test("a forged cookie is refused", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const future = Math.floor(Date.now() / 1000) + 9999;
    for (const forged of [
      `trace_session=${future}.notavalidmac`,
      "trace_session=abc.def",
      "trace_session=",
    ]) {
      const response = await app.fetch(
        new Request("http://localhost/api/nodes", { headers: { cookie: forged } }),
      );
      expect({ forged, status: response.status }).toEqual({ forged, status: 401 });
    }
  });

  test("a cookie signed with a different passphrase does not transfer", async () => {
    const login = await appWith({ ownerPassphrase: PASSPHRASE }).fetch(
      formTo("/login", { passphrase: PASSPHRASE }),
    );
    const cookie = cookieFrom(login);

    // Rotating the passphrase invalidates every outstanding session, for free.
    const rotated = appWith({ ownerPassphrase: "a-different-passphrase" });
    expect(
      (await rotated.fetch(new Request("http://localhost/api/nodes", { headers: { cookie } }))).status,
    ).toBe(401);
  });

  /**
   * Two instances (PRD §8.1a): trace-node and digger-node share a host on
   * kvmlab1, and cookies are host-scoped, not port-scoped. A distinct cookie
   * name keeps them from logging each other out; a distinct key keeps one
   * from OPENING the other. Two createApps on two stores, different
   * passphrases: A's cookie replayed to B is refused. This is the worker's
   * DONE line for the two-instance verify — the browser half is the lead's.
   */
  test("two instances: a cookie minted by A replayed to B → 401", async () => {
    const storeA = await openSqliteStore(":memory:", migrations);
    const storeB = await openSqliteStore(":memory:", migrations);
    const a = createApp({ store: storeA, instanceName: "a", auth: { ownerPassphrase: "passphrase-for-instance-a" } });
    const b = createApp({ store: storeB, instanceName: "b", auth: { ownerPassphrase: "passphrase-for-instance-b" } });

    const loginA = await a.fetch(formTo("/login", { passphrase: "passphrase-for-instance-a" }));
    expect(loginA.status).toBe(302);
    const cookieA = cookieFrom(loginA);
    expect(cookieA).toContain("trace_session=");

    expect((await a.fetch(new Request("http://localhost/api/nodes", { headers: { cookie: cookieA } }))).status).toBe(200);
    expect((await b.fetch(new Request("http://localhost/api/nodes", { headers: { cookie: cookieA } }))).status).toBe(401);

    // And B's own cookie opens B, so the 401 above is the key, not the shape.
    const cookieB = cookieFrom(await b.fetch(formTo("/login", { passphrase: "passphrase-for-instance-b" })));
    expect((await b.fetch(new Request("http://localhost/api/nodes", { headers: { cookie: cookieB } }))).status).toBe(200);
    expect((await a.fetch(new Request("http://localhost/api/nodes", { headers: { cookie: cookieB } }))).status).toBe(401);
  });

  test("`next` cannot be turned into an open redirect", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    for (const [next, expected] of [
      ["//evil.example.com", "/"],
      ["https://evil.example.com", "/"],
      ["/api/stats", "/api/stats"],
    ] as const) {
      const login = await app.fetch(formTo("/login", { passphrase: PASSPHRASE, next }));
      expect({ next, to: login.headers.get("location") }).toEqual({ next, to: expected });
    }
  });

  test("logout clears the cookie", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const response = await app.fetch(formTo("/logout", {}));
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  /**
   * The cookie leaves the app (PRD §3.9 #7): minted inside the ingress iframe
   * it lived at `Path=/` on Home Assistant's origin, so the browser sent it to
   * HA and to every other add-on's ingress path. Scoped to the ingress prefix
   * it reaches only this add-on.
   */
  test("an ingress-issued cookie carries Path=<ingressBase>, and logout clears it there", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const base = "/api/hassio_ingress/tok";
    const login = await app.fetch(
      new Request("http://localhost/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-ingress-path": base },
        body: new URLSearchParams({ passphrase: PASSPHRASE }).toString(),
      }),
    );
    expect(login.status).toBe(302);
    expect(login.headers.get("set-cookie")).toContain(`Path=${base}`);

    const logout = await app.fetch(
      new Request("http://localhost/logout", { method: "POST", headers: { "x-ingress-path": base } }),
    );
    expect(logout.headers.get("set-cookie")).toContain(`Path=${base}`);
    expect(logout.headers.get("location")).toBe(`${base}/`);

    // A direct login is still at the root.
    const direct = await app.fetch(formTo("/login", { passphrase: PASSPHRASE }));
    expect(direct.headers.get("set-cookie")).toContain("Path=/;");

    // With auto-login on, the passphrase form is not offered through ingress.
    const auto = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true });
    const form = await auto.fetch(new Request("http://localhost/login", { headers: { "x-ingress-path": base } }));
    expect(form.status).toBe(302);
    expect(form.headers.get("location")).toBe(`${base}/`);
  });
});


/**
 * Ingress auto-login — and the four ways it must refuse.
 *
 * Home Assistant already authenticated whoever is looking at the sidebar panel,
 * so asking for a passphrase one iframe deeper guards a door that is already
 * locked. The risk is the mapped port: digger-node publishes 8108 so MCP
 * clients can reach it, and that port answers anyone on the LAN or the VPN.
 *
 * A sibling add-on on this fleet takes the simple route — a flag that mints a
 * full admin token for anyone who can reach its port — and says so in its own
 * comments. These tests exist because that trade is avoidable here: the header
 * says "rendered inside the iframe", the SOURCE ADDRESS says "and it is really
 * Home Assistant asking", and only both together are enough.
 */
describe("ingress auto-login", () => {
  // Pattern B (PRD §3.9 #6, §8.1a table): the peer must EQUAL `ingressPeer`,
  // the path must be Supervisor's own shape, and X-Remote-User-Id rides along.
  const PEER = "x-trace-peer-ip";
  const INGRESS_PEER = "172.30.32.1";
  const PATH = "/api/hassio_ingress/tok";
  const ID = "ha_user_a";
  const ingressReq = (headers: Record<string, string>) =>
    new Request("http://localhost/api/nodes", { headers });

  test("off by default: a perfect ingress request is still refused", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressPeer: INGRESS_PEER });
    const response = await app.fetch(
      ingressReq({ "x-ingress-path": PATH, [PEER]: INGRESS_PEER, "x-remote-user-id": ID }),
    );
    expect(response.status).toBe(401);
  });

  test("on: an ingress request from the ingress peer is let in", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true, ingressPeer: INGRESS_PEER });
    const response = await app.fetch(
      ingressReq({ "x-ingress-path": PATH, [PEER]: INGRESS_PEER, "x-remote-user-id": ID }),
    );
    expect(response.status).toBe(200);
  });

  test("the header alone proves nothing — anyone can send it", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true, ingressPeer: INGRESS_PEER });
    const response = await app.fetch(ingressReq({ "x-ingress-path": PATH, "x-remote-user-id": ID }));
    expect(response.status).toBe(401);
  });

  test("THE POINT: the same request from the LAN or the VPN is refused", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true, ingressPeer: INGRESS_PEER });
    for (const peer of ["100.97.192.167", "192.168.1.50", "10.0.0.4", "172.31.32.1", "172.30.34.1"]) {
      const response = await app.fetch(
        ingressReq({ "x-ingress-path": PATH, [PEER]: peer, "x-remote-user-id": ID }),
      );
      expect({ peer, status: response.status }).toEqual({ peer, status: 401 });
    }
  });

  test("the bridge address alone is not enough either — both halves required", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true, ingressPeer: INGRESS_PEER });
    const response = await app.fetch(ingressReq({ [PEER]: INGRESS_PEER, "x-remote-user-id": ID }));
    expect(response.status).toBe(401);
  });

  test("only the exact ingress peer: 172.30.33.9 inside the /23 and 172.30.32.5 are refused, and so is path /x", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true, ingressPeer: INGRESS_PEER });
    // Pattern A admitted any bridge peer; at gate 3 the cloudflared container
    // is a bridge peer too, so that was a full bypass.
    for (const peer of ["172.30.33.9", "172.30.32.5", "172.30.31.9"]) {
      const response = await app.fetch(
        ingressReq({ "x-ingress-path": PATH, [PEER]: peer, "x-remote-user-id": ID }),
      );
      expect({ peer, status: response.status }).toEqual({ peer, status: 401 });
    }
    // The right peer with a path Supervisor would never write.
    const badPath = await app.fetch(
      ingressReq({ "x-ingress-path": "/x", [PEER]: INGRESS_PEER, "x-remote-user-id": ID }),
    );
    expect(badPath.status).toBe(401);
  });

  test("an IPv4-mapped IPv6 form of the exact peer is still recognised", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true, ingressPeer: INGRESS_PEER });
    const response = await app.fetch(
      ingressReq({ "x-ingress-path": PATH, [PEER]: `::ffff:${INGRESS_PEER}`, "x-remote-user-id": ID }),
    );
    expect(response.status).toBe(200);
  });

  /**
   * Pattern B in full, on the DEFAULT peer (PRD §3.9 #6, §8.1a auth additions):
   * .2 + path + id admitted with ha_user; .5 refused; a forwarded header
   * claiming .2 from 10.0.0.9 refused; a trusted-proxy peer refused even when
   * it is the configured ingress peer.
   */
  test("Pattern B: .2 + path + id → ha_user; .5, X-Forwarded-For and a trusted-proxy peer → 401", async () => {
    const { callerOf } = await import("../src/auth-plugin");
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true });

    const admitted = ingressReq({ "x-ingress-path": PATH, [PEER]: "172.30.32.2", "x-remote-user-id": "nat" });
    expect((await app.fetch(admitted)).status).toBe(200);
    // The gate published the caller on the SAME Request object (PRD §3.1).
    expect(callerOf(admitted)).toMatchObject({ method: "ingress", principal: "172.30.32.2", ha_user: "nat" });

    expect(
      (await app.fetch(ingressReq({ "x-ingress-path": PATH, [PEER]: "172.30.32.5", "x-remote-user-id": "nat" }))).status,
    ).toBe(401);

    const forwarded = ingressReq({
      "x-ingress-path": PATH,
      [PEER]: "10.0.0.9",
      "x-forwarded-for": "172.30.32.2",
      "x-remote-user-id": "nat",
    });
    expect((await app.fetch(forwarded)).status).toBe(401);

    const proxied = appWith({
      ownerPassphrase: PASSPHRASE,
      ingressAutoLogin: true,
      ingressPeer: "172.30.32.9",
      trustedProxies: ["172.30.32.9"],
    });
    expect(
      (await proxied.fetch(ingressReq({ "x-ingress-path": PATH, [PEER]: "172.30.32.9", "x-remote-user-id": "nat" }))).status,
    ).toBe(401);
  });

  test("a real credential still wins, so the call log records how they proved it", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, apiToken: API_TOKEN, ingressAutoLogin: true });
    const health = await app.fetch(
      new Request("http://localhost/api/health", { headers: { authorization: `Bearer ${API_TOKEN}` } }),
    );
    expect(((await health.json()) as any).auth).toContain("ingress");
  });
});

/**
 * The connections ledger — "who is connected, and is claude.ai among them?"
 *
 * The distinction that earns this its own suite: Claude Code can also arrive
 * over OAuth, so labelling every OAuth client "claude.ai" would answer the
 * question wrongly in exactly the case worth asking about. The label follows
 * the REGISTERED redirect_uri, not the transport.
 */
describe("connections ledger", () => {
  const get = async (app: ReturnType<typeof createApp>, token: string, path: string, ua?: string) =>
    app.fetch(
      new Request(`http://localhost${path}`, {
        headers: { authorization: `Bearer ${token}`, ...(ua ? { "user-agent": ua } : {}) },
      }),
    );

  const readLedger = async (app: ReturnType<typeof createApp>) => {
    const response = await app.fetch(
      new Request("http://localhost/api/connections?since=all", {
        headers: { authorization: `Bearer ${API_TOKEN}` },
      }),
    );
    return (await response.json()) as any;
  };

  test("a static-token caller is identified by its user-agent family", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    await get(app, API_TOKEN, "/api/nodes", "claude-code/1.2 (darwin)");
    const body = await readLedger(app);
    // The ledger READ is itself an api-token request, and it carries no
    // user-agent — so it makes its own `unknown` row and, being newest, sorts
    // first. Find the row we mean by label rather than by "first of this method".
    const row = body.connections.find((c: any) => c.label === "Claude Code");
    expect(row).toBeDefined();
    expect(row.requests).toBeGreaterThanOrEqual(1);
  });

  test("repeat requests fold into ONE row and increment it", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    for (let i = 0; i < 3; i++) await get(app, API_TOKEN, "/api/nodes", "curl/8.4.0");
    const body = await readLedger(app);
    const rows = body.connections.filter((c: any) => c.label === "curl");
    expect(rows.length).toBe(1);
    expect(rows[0].requests).toBeGreaterThanOrEqual(3);
  });

  test("/health is not a caller and is never counted", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    await app.fetch(new Request("http://localhost/health"));
    const body = await readLedger(app);
    expect(body.connections.every((c: any) => c.requests > 0)).toBe(true);
    // the only row is the ledger read itself, never a health probe
    expect(body.connections.some((c: any) => c.lastTool === "/health")).toBe(false);
  });

  test("an ingress caller is 'HA sidebar' and carries the bridge address", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true });
    // Since 1b-3 an ingress request must NAME its HA user (PRD §8.1b): Supervisor
    // omits X-Remote-User-Id when nobody is signed in, and that is a 401.
    const sidebar = { "x-ingress-path": "/api/hassio_ingress/t", "x-trace-peer-ip": "172.30.32.2", "x-remote-user-id": "nat" };
    await app.fetch(new Request("http://localhost/api/nodes", { headers: sidebar }));
    const response = await app.fetch(new Request("http://localhost/api/connections?since=all", { headers: sidebar }));
    const body = (await response.json()) as any;
    const row = body.connections.find((c: any) => c.method === "ingress");
    expect(row.label).toBe("HA sidebar");
    expect(row.remoteIp).toBe("172.30.32.2");
  });

  test("claude.ai is recognised by its REGISTERED callback, not by its transport", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, apiToken: API_TOKEN });
    const claude = await registerClient(app, ["https://claude.ai/api/mcp/auth_callback"]);
    const other = await registerClient(app, ["http://localhost:9999/cb"]);
    const { isClaudeAiClient } = await import("../src/connections");
    expect(isClaudeAiClient(["https://claude.ai/api/mcp/auth_callback"])).toBe(true);
    expect(isClaudeAiClient(["https://claude.com/x"])).toBe(true);
    expect(isClaudeAiClient(["http://localhost:9999/cb"])).toBe(false);
    // and a host that merely CONTAINS the string is not claude.ai
    expect(isClaudeAiClient(["https://notclaude.ai.evil.test/cb"])).toBe(false);
    expect(claude.status).toBe(201);
    expect(other.status).toBe(201);
  });

  test("claude_ai reports none until a claude.ai client actually exists", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    await get(app, API_TOKEN, "/api/nodes", "curl/8.4.0");
    const body = await readLedger(app);
    expect(body.claude_ai).toBe("none");
  });

  test("the ledger stores no credential", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    await get(app, API_TOKEN, "/api/nodes", "claude-code/1.0");
    const raw = JSON.stringify(await readLedger(app));
    expect(raw).not.toContain(API_TOKEN);
  });

  /**
   * digger-node's UPSERT composed `tool_calls` and `last_tool` but nothing ever
   * wrote them (PRD §3.9 #1). The /mcp handler now records the tool AFTER the
   * call, with `requests: 0` so the request the gate already counted is not
   * counted twice.
   */
  test("a tools/call writes tool_calls and last_tool, and counts the request once", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    const mcp = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_TOKEN}`,
          "user-agent": "curl/8.4.0",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: {} } }),
      }),
    );
    expect(mcp.status).toBe(200);
    const body = await readLedger(app);
    const row = body.connections.find((c: any) => c.label === "curl");
    expect(row).toBeDefined();
    expect(row.toolCalls).toBe(1);
    expect(row.lastTool).toBe("status");
    expect(row.requests).toBe(1);
  });
});

/**
 * Fail-closed boot (PRD §6.3). digger's run.sh fell back to a fixed literal
 * passphrase and the app started OPEN whenever both secrets were blank; here
 * every misconfiguration is one line and exit 1 before the port is bound. The
 * checks are a pure function of the env, so they are tested without a process.
 */
describe("fail-closed boot", () => {
  test("refuses a blank passphrase, a short token, an ingress_peer off the bridge, ALLOW_OPEN inside the add-on; starts OPEN outside it", async () => {
    const { bootProblem } = await import("../src/boot");
    const good = { OWNER_PASSPHRASE: PASSPHRASE, API_TOKEN: API_TOKEN };

    // A well-formed env starts.
    expect(bootProblem(good)).toBeNull();
    // 1. blank passphrase with the default require_owner_passphrase=true
    expect(bootProblem({})).toMatch(/owner_passphrase is not set/);
    expect(bootProblem({ API_TOKEN })).toMatch(/owner_passphrase is not set/);
    // 2. require=false still needs SOMETHING
    expect(bootProblem({ REQUIRE_OWNER_PASSPHRASE: "false" })).toMatch(/owner_passphrase is not set/);
    expect(bootProblem({ REQUIRE_OWNER_PASSPHRASE: "false", API_TOKEN })).toBeNull();
    // 3. short token
    expect(bootProblem({ ...good, API_TOKEN: "short-token" })).toMatch(/api_token is shorter than 24/);
    // 4. short passphrase
    expect(bootProblem({ ...good, OWNER_PASSPHRASE: "elevenchars" })).toMatch(/owner_passphrase is shorter than 12/);
    // 5. ingress_peer must be one IPv4 inside the bridge, and never a trusted proxy
    expect(bootProblem({ ...good, INGRESS_PEER: "10.0.0.5" })).toMatch(/ingress_peer .* 172\.30\.32\.0\/23/);
    expect(bootProblem({ ...good, INGRESS_PEER: "172.30.32.0/23" })).toMatch(/ingress_peer/);
    expect(bootProblem({ ...good, INGRESS_PEER: "172.30.32.2", TRUSTED_PROXIES: "172.30.32.0/23" })).toMatch(/inside trusted_proxies/);
    expect(bootProblem({ ...good, TRUSTED_PROXIES: "172.30.32.9" })).toBeNull();
    // 6. OPEN mode and proof-proxy peers never reach the add-on
    expect(bootProblem({ ALLOW_OPEN: "1", DB_PATH: "/data/x" })).toMatch(/ALLOW_OPEN .* inside the add-on/);
    expect(bootProblem({ ALLOW_OPEN: "1", SUPERVISOR_TOKEN: "s" })).toMatch(/ALLOW_OPEN .* inside the add-on/);
    expect(bootProblem({ ...good, INGRESS_TRUSTED_PEER: "10.0.0.1", DB_PATH: "/data/trace.db" })).toMatch(/INGRESS_TRUSTED_PEER/);
    // ...but ALLOW_OPEN=1 starts outside it, with no credential at all.
    expect(bootProblem({ ALLOW_OPEN: "1", DB_PATH: "./trace.db" })).toBeNull();
    // Every refusal is one line.
    for (const env of [{}, { ...good, API_TOKEN: "x" }, { ALLOW_OPEN: "1", DB_PATH: "/data/x" }]) {
      expect(bootProblem(env)).not.toContain("\n");
    }
  });
});

/**
 * One sidebar, one row — even when the tunnel forwards a different visitor IP.
 *
 * Behind Cloudflare, cf-connecting-ip is the END USER's public address. Keying
 * the ingress row on it minted a new "HA sidebar" row per visitor, which was
 * seen live as `HA sidebar · ingress · 124.121.144.27` and would have grown the
 * table without bound.
 */
describe("ingress identity survives a tunnel", () => {
  test("two visitors through the tunnel are ONE HA sidebar row", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true });
    for (const visitor of ["124.121.144.27", "203.0.113.9"]) {
      await app.fetch(
        new Request("http://localhost/api/nodes", {
          headers: {
            "x-ingress-path": "/api/hassio_ingress/t",
            "x-trace-peer-ip": "172.30.32.2",
            "x-remote-user-id": "nat",
            "cf-connecting-ip": visitor,
          },
        }),
      );
    }
    const response = await app.fetch(
      new Request("http://localhost/api/connections?since=all", {
        headers: { "x-ingress-path": "/api/hassio_ingress/t", "x-trace-peer-ip": "172.30.32.2", "x-remote-user-id": "nat" },
      }),
    );
    const rows = ((await response.json()) as any).connections.filter((c: any) => c.method === "ingress");
    // The claim under test: ONE row for two different visitors. remote_ip is
    // deliberately not asserted — it follows the latest request, and the latest
    // request is this very read.
    expect(rows.length).toBe(1);
    expect(rows[0].principal).toBe("172.30.32.2");
    expect(rows[0].requests).toBeGreaterThanOrEqual(3);
  });
});

/**
 * The claude.ai connection checklist (PRD §5), as one ordered describe. Items
 * 1–4 land in step 1; `GET /mcp` 405, the protocol versions, DCR for the
 * claude.ai callback and `tools/list = 23` land in step 4 with the new tools.
 * Exact values: gate 1 runs the same checks with curl, gate 3 with the UI.
 */
describe("claude.ai handshake", () => {
  test("1. issuer is byte-identical to the origin the client reached", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const body = (await (await app.fetch(new Request("http://localhost/.well-known/oauth-authorization-server"))).json()) as any;
    expect(body.issuer).toBe("http://localhost");
    expect(body.authorization_endpoint).toBe("http://localhost/authorize");
    expect(body.token_endpoint).toBe("http://localhost/oauth/token");
    expect(body.registration_endpoint).toBe("http://localhost/oauth/register");
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.grant_types_supported).toEqual(["authorization_code"]);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
    expect(body.scopes_supported).toEqual(["nodes:read", "nodes:write", "traces:read"]);
    // The OIDC alias is the same document.
    const oidc = await (await app.fetch(new Request("http://localhost/.well-known/openid-configuration"))).json();
    expect(oidc).toEqual(body);
    // A forged x-forwarded-host from an untrusted peer does not move the issuer.
    const forged = (await (
      await app.fetch(
        new Request("http://localhost/.well-known/oauth-authorization-server", {
          headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", "x-trace-peer-ip": "10.0.0.9" },
        }),
      )
    ).json()) as any;
    expect(forged.issuer).toBe("http://localhost");
    // PUBLIC_URL wins, with the trailing slash stripped.
    const pinned = createApp({ store, auth: { ownerPassphrase: PASSPHRASE }, publicUrl: "https://trace.example.com/" });
    const doc = (await (await pinned.fetch(new Request("http://localhost/.well-known/oauth-authorization-server"))).json()) as any;
    expect(doc.issuer).toBe("https://trace.example.com");
  });

  test("2. protected-resource metadata: resource = <origin>/mcp, at both RFC 9728 paths", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const body = (await response.json()) as any;
      expect(body.resource).toBe("http://localhost/mcp");
      expect(body.authorization_servers).toEqual(["http://localhost"]);
      expect(body.bearer_methods_supported).toEqual(["header"]);
    }
  });

  test("3. the 401 on /mcp carries the challenge claude.ai follows, and exposes it", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const response = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    );
    // A real HTTP 401, never a 200 wrapping an error.
    expect(response.status).toBe(401);
    const header = response.headers.get("www-authenticate") ?? "";
    expect(header.startsWith('Bearer realm="trace-node", ')).toBe(true);
    expect(header).toContain('error="invalid_token"');
    expect(header).toContain('error_description="');
    expect(header).toContain('resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"');
    // traces:read is opt-in on the consent page, never advertised here.
    expect(header).toContain('scope="nodes:read nodes:write"');
    expect(header).not.toContain("traces:read");
    expect(response.headers.get("access-control-expose-headers")).toContain("www-authenticate");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("4. OPTIONS answers 204 with the headers and methods a browser client needs", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    for (const path of ["/mcp", "/api/nodes", "/.well-known/oauth-authorization-server"]) {
      const response = await app.fetch(new Request(`http://localhost${path}`, { method: "OPTIONS" }));
      expect({ path, status: response.status }).toEqual({ path, status: 204 });
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      // Extended at 1b-3 with the two 2026-07-28 request headers (PRD §8.1b (3)).
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "authorization, content-type, mcp-protocol-version, mcp-method, mcp-name",
      );
      expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    }
  });

  test("5. GET /mcp and DELETE /mcp are 405 with a credential — never 404 — and a real 401 without one", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, apiToken: API_TOKEN });
    const bearer = { authorization: `Bearer ${API_TOKEN}` };
    for (const method of ["GET", "DELETE"]) {
      const response = await app.fetch(new Request("http://localhost/mcp", { method, headers: bearer }));
      expect({ method, status: response.status }).toEqual({ method, status: 405 });
      expect(((await response.json()) as any).error).toBe("method_not_allowed");
      // Anonymous: the gate answers first, and it is an HTTP 401, not a 200.
      const anonymous = await app.fetch(new Request("http://localhost/mcp", { method }));
      expect({ method, status: anonymous.status }).toEqual({ method, status: 401 });
    }
  });

  test("6. protocol versions (§5.1 v0.3.1): 2025-11-25 echoed; 2026-07-28, 2099-01-01 and banana → 2025-11-25, each logged; initialized 202; ping; unknown → -32601", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, apiToken: API_TOKEN });
    const rpc = async (body: Record<string, unknown>) =>
      app.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${API_TOKEN}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
        }),
      );
    // 2026-07-28 is a different wire format (no `initialize`) and is never answered
    // until 1b-mcp2026 implements it — a modern client negotiates down to 2025-11-25.
    for (const [asked, answered] of [
      ["2025-11-25", "2025-11-25"],
      ["2026-07-28", "2025-11-25"],
      ["2024-11-05", "2024-11-05"],
      ["2099-01-01", "2025-11-25"],
      ["banana", "2025-11-25"],
    ]) {
      const body = (await (await rpc({ method: "initialize", params: { protocolVersion: asked } })).json()) as any;
      expect({ asked, answered: body.result.protocolVersion }).toEqual({ asked, answered });
      expect(body.result.serverInfo.name).toBe("trace-node");
      expect(typeof body.result.instructions).toBe("string");
    }
    // Logged, never echoed: the operator can see what clients actually send, in first-seen order.
    const health = (await (await app.fetch(new Request("http://localhost/api/health", { headers: { authorization: `Bearer ${API_TOKEN}` } }))).json()) as any;
    expect(health.protocol_versions_seen).toEqual(["2025-11-25", "2026-07-28", "2024-11-05", "2099-01-01", "banana"]);
    for (const method of ["notifications/initialized", "initialized"]) {
      const response = await rpc({ method });
      expect({ method, status: response.status }).toEqual({ method, status: 202 });
      expect(await response.text()).toBe("");
    }
    expect(((await (await rpc({ method: "ping" })).json()) as any).result).toEqual({});
    const unknown = (await (await rpc({ method: "resources/list" })).json()) as any;
    expect(unknown.error.code).toBe(-32601);
    // A tool failure is isError inside a 200; a missing credential is a real 401.
    const failed = await rpc({ method: "tools/call", params: { name: "node_get", arguments: { id: "nope" } } });
    expect(failed.status).toBe(200);
    expect(((await failed.json()) as any).result.isError).toBe(true);
    const bare = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(bare.status).toBe(401);
  });

  test("7. DCR: 201 with no client_secret for https://claude.ai/api/mcp/auth_callback, Cache-Control: no-store", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const response = await app.fetch(
      new Request("http://localhost/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as any;
    expect(typeof body.client_id).toBe("string");
    expect(body.client_id.length).toBeGreaterThanOrEqual(16);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.grant_types).toEqual(["authorization_code"]);
    expect(body.response_types).toEqual(["code"]);
    expect(body.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    expect("client_secret" in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain("secret");
    // The same registration on a server with OAuth unconfigured is 501, not 404.
    const off = appWith({ apiToken: API_TOKEN });
    const refused = await off.fetch(
      new Request("http://localhost/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
      }),
    );
    expect(refused.status).toBe(501);
    expect(((await refused.json()) as any).error).toBe("oauth_not_configured");
  });

  test("8. tools/list is exactly 23 — 19 inherited by name + tag_cloud, trace, category, dig — and dig says it writes", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, apiToken: API_TOKEN });
    const response = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${API_TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    const tools = ((await response.json()) as any).result.tools as Array<{ name: string; annotations?: Record<string, boolean> }>;
    expect(tools.length).toBe(23);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(23);
    // The inherited nineteen, by name (PRD §3.4).
    for (const inherited of [
      "node_create", "node_get", "node_update", "node_delete", "node_list", "node_types", "vocabulary_delete",
      "node_search", "node_embed", "node_tag", "node_untag", "vocabulary_create", "vocabulary_list",
      "term_create", "term_weight", "term_list", "call_log", "call_stats", "status",
    ]) {
      expect({ inherited, present: names.includes(inherited) }).toEqual({ inherited, present: true });
    }
    expect(names.slice(19)).toEqual(["tag_cloud", "trace", "category", "dig"]);
    // Annotations are honest: the log's readers are read-only, the dig is not.
    expect(tools.find((t) => t.name === "tag_cloud")!.annotations).toEqual({ readOnlyHint: true });
    expect(tools.find((t) => t.name === "trace")!.annotations).toEqual({ readOnlyHint: true });
    expect(tools.find((t) => t.name === "dig")!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    // /api/tools and /api/health agree.
    const bearer = { authorization: `Bearer ${API_TOKEN}` };
    expect((((await (await app.fetch(new Request("http://localhost/api/tools", { headers: bearer }))).json()) as any).tools as unknown[]).length).toBe(23);
    expect(((await (await app.fetch(new Request("http://localhost/api/health", { headers: bearer }))).json()) as any).tools).toBe(23);
  });
});

/**
 * Every registered route, enumerated from Elysia itself (`app.routes`, Elysia
 * 1.4.30), asked anonymously: everything outside the gate's allow-list is a
 * 401. This guards the `as: "global"` on the gate — a hook that silently went
 * local would leave every parent route open while every other test here still
 * passed, because they only ever ask about the routes they know.
 */
describe("routes closed", () => {
  test("every route outside PUBLIC_PATHS answers 401 anonymously — enumerated, not listed by hand", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, apiToken: API_TOKEN });
    // Bodies that pass each route's schema, so the answer is the gate's and not
    // the validator's: Elysia validates a body BEFORE a global onBeforeHandle
    // runs, so an invalid anonymous body is a 400 — no handler runs, but the
    // 401 this test wants must be reached with a well-formed one.
    const bodies: Record<string, unknown> = {
      "POST /api/vocabularies": { name: "v" },
      "POST /api/terms": { vocabulary: "v", name: "t" },
      "POST /api/nodes/:id/tags": { terms: ["tags:x"] },
      "POST /api/nodes": { title: "t" },
      "POST /mcp": { jsonrpc: "2.0", id: 1, method: "tools/list" },
    };
    const routes = app.routes.map((r) => ({ method: r.method, path: r.path }));
    expect(routes.length).toBeGreaterThan(40);
    const asked: string[] = [];
    const open: string[] = [];
    for (const { method, path } of routes) {
      if (method === "OPTIONS" || path.includes("*")) continue;
      const concrete = path.replace(/:[A-Za-z_]+/g, "x");
      const key = `${method} ${path}`;
      const init: RequestInit = { method };
      if (method !== "GET" && method !== "HEAD") {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(bodies[key] ?? {});
      }
      const response = await app.fetch(new Request(`http://localhost${concrete}`, init));
      asked.push(key);
      if (isPublicPath(path)) {
        // The allow-list earns each entry: the gate never answered here. (A
        // public /login or /authorize can still say 401 to a wrong passphrase
        // — that is the door's own refusal, and it carries no Bearer challenge.)
        expect({ key, challenge: response.headers.get("www-authenticate") }).toEqual({ key, challenge: null });
        open.push(key);
      } else {
        expect({ key, status: response.status }).toEqual({ key, status: 401 });
        if (path === "/mcp" || path.startsWith("/api/")) {
          expect(response.headers.get("www-authenticate") ?? "").toContain('realm="trace-node"');
        }
      }
    }
    // The public surface is exactly the allow-list, and the gate reached every new route.
    expect(open.sort()).toEqual(
      [
        "GET /", "GET /.well-known/oauth-authorization-server", "GET /.well-known/oauth-protected-resource",
        "GET /.well-known/oauth-protected-resource/mcp", "GET /.well-known/openid-configuration", "GET /authorize",
        "GET /health", "GET /login", "POST /authorize", "POST /login", "POST /logout", "POST /oauth/register", "POST /oauth/token",
      ].sort(),
    );
    for (const fresh of ["GET /api/cloud", "GET /api/trace", "GET /api/categories/:id", "POST /api/dig", "GET /api/dig", "GET /api/digs", "GET /api/traces", "GET /api/health"]) {
      expect({ fresh, asked: asked.includes(fresh) }).toEqual({ fresh, asked: true });
    }
  });
});

/**
 * No credential in any JSON (PRD §8.1a). Random secrets per run; every table
 * and every new endpoint's body is exported and searched for the passphrase,
 * the api token, a raw OAuth token and a SUPERVISOR_TOKEN. Hashes at rest are
 * fine; the raw strings must never be.
 */
describe("no credential in any JSON", () => {
  test("every table and every new endpoint's body is free of the passphrase, the api token, a raw OAuth token and SUPERVISOR_TOKEN", async () => {
    const secrets = {
      passphrase: `pass-${crypto.randomUUID()}`,
      apiToken: `token-${crypto.randomUUID()}${crypto.randomUUID()}`,
      supervisor: `supervisor-${crypto.randomUUID()}`,
    };
    const hadSupervisor = process.env.SUPERVISOR_TOKEN;
    process.env.SUPERVISOR_TOKEN = secrets.supervisor;
    try {
      const app = createApp({
        store,
        instanceName: "test",
        auth: { ownerPassphrase: secrets.passphrase, apiToken: secrets.apiToken, ingressAutoLogin: true, ingressPeer: "172.30.32.2" },
      });
      const bearer = { authorization: `Bearer ${secrets.apiToken}`, "user-agent": "curl/8.4.0" };
      const jsonPost = (path: string, body: unknown, headers: Record<string, string>) =>
        app.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
      const rpc = (name: string, args: Record<string, unknown>, headers: Record<string, string>) =>
        jsonPost("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers);

      // Every credential gets used, so every table has rows from every door.
      const login = await app.fetch(formTo("/login", { passphrase: secrets.passphrase }));
      expect(login.status).toBe(302);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
      const changed = await jsonPost("/api/passphrase", { next: `next-${secrets.passphrase}` }, { cookie, "x-trace-client": "ui" });
      expect(changed.status).toBe(200);
      const cookie2 = (changed.headers.get("set-cookie") ?? "").split(";")[0]!;
      const ui = { cookie: cookie2, "x-trace-client": "ui" };

      const { body: client } = await registerClient(app);
      const verifier = "a-verifier-long-enough-to-be-real-43-chars-min";
      const approved = await app.fetch(
        formTo("/authorize", {
          passphrase: secrets.passphrase,
          client_id: client.client_id,
          redirect_uri: REDIRECT,
          state: "xyz",
          code_challenge: await sha256Base64Url(verifier),
          code_challenge_method: "S256",
          scope: "nodes:read nodes:write",
          resource: "http://localhost/mcp",
          traces_read: "1",
        }),
      );
      const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
      const token = (await (
        await app.fetch(formTo("/oauth/token", { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier }))
      ).json()) as any;
      const oauth = { authorization: `Bearer ${token.access_token}`, "user-agent": "claude-ai/1.0" };
      const ingress = { "x-ingress-path": "/api/hassio_ingress/abc", "x-trace-peer-ip": "172.30.32.2", "x-remote-user-id": "alice", "x-trace-client": "ui", "user-agent": "Mozilla/5.0" };

      expect((await rpc("vocabulary_create", { name: "topics", kind: "categories" }, bearer)).status).toBe(200);
      // Controlled vocabulary: the term must exist before a node can wear it.
      expect((await rpc("term_create", { vocabulary: "topics", name: "infra" }, bearer)).status).toBe(200);
      expect((await rpc("node_create", { title: "MCP gateway", body: "notes", terms: ["tags:mcp", "topics:infra"] }, bearer)).status).toBe(200);
      const terms = ((await (await app.fetch(new Request("http://localhost/api/terms", { headers: bearer }))).json()) as any).terms as Array<{ id: string; name: string }>;
      const infra = terms.find((t) => t.name === "infra")!;
      const nodes = ((await (await app.fetch(new Request("http://localhost/api/nodes?q=mcp", { headers: ui }))).json()) as any).nodes as Array<{ id: string }>;
      for (const headers of [bearer, ui, oauth, ingress]) {
        expect((await rpc("node_search", { query: "mcp" }, headers)).status).toBe(200);
        expect((await rpc("dig", { keyword: "mcp" }, headers)).status).toBe(200);
        expect((await jsonPost("/api/dig", { q: "mcp" }, headers)).status).toBe(200);
        expect((await app.fetch(new Request(`http://localhost/api/nodes/${nodes[0]!.id}`, { headers }))).status).toBe(200);
        expect((await app.fetch(new Request(`http://localhost/api/categories/${infra.id}`, { headers }))).status).toBe(200);
      }
      // A wrong guess lands in auth_attempts too.
      expect((await app.fetch(formTo("/login", { passphrase: "not-it-at-all" }))).status).toBe(401);

      const raw = [secrets.passphrase, `next-${secrets.passphrase}`, secrets.apiToken, token.access_token as string, secrets.supervisor];
      const clean = (label: string, text: string) => {
        for (const secret of raw) expect({ label, leaks: text.includes(secret) }).toEqual({ label, leaks: false });
      };

      // Every table, as JSON.
      const tables = (await store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'")).map((t) => t.name);
      for (const required of ["traces", "trace_days", "digs", "connections", "mcp_calls", "settings", "oauth_clients", "oauth_codes", "oauth_tokens", "auth_attempts"]) {
        expect({ required, present: tables.includes(required) }).toEqual({ required, present: true });
      }
      for (const table of tables) {
        const rows = await store.all(`SELECT * FROM ${table}`);
        clean(`table ${table}`, JSON.stringify(rows));
      }
      expect((await store.all("SELECT * FROM digs")).length).toBe(8);
      expect((await store.all("SELECT * FROM oauth_tokens")).length).toBe(1);

      // Every endpoint the trace layer added, plus the inherited ones that carry identities.
      const endpoints = [
        "/api/health", "/api/cloud", "/api/cloud?window=24h&by=all", "/api/trace?q=mcp", `/api/trace?term=${infra.id}`, `/api/trace?node=${nodes[0]!.id}`,
        "/api/categories", `/api/categories/${infra.id}`, "/api/digs", "/api/digs?q=mcp", "/api/traces", "/api/timeline", "/api/connections?since=all",
        "/api/calls", "/api/calls/stats", "/api/clients", "/api/passphrase", "/api/stats", "/api/tools", "/health",
      ];
      for (const headers of [bearer, ui, oauth, ingress] as Array<Record<string, string>>) {
        for (const path of endpoints) {
          const response = await app.fetch(new Request(`http://localhost${path}`, { headers }));
          expect({ path, status: response.status }).toEqual({ path, status: response.status === 403 ? 403 : 200 });
          clean(`${path} as ${headers["user-agent"] ?? "browser"}`, await response.text());
        }
        clean("POST /api/dig", await (await jsonPost("/api/dig", { q: "mcp" }, headers)).text());
        for (const [name, args] of [["status", {}], ["call_log", { limit: 200 }], ["tag_cloud", {}], ["trace", { keyword: "mcp" }], ["dig", { keyword: "mcp" }], ["category", { id: infra.id }]] as const) {
          clean(`tool ${name}`, await (await rpc(name, args as Record<string, unknown>, headers)).text());
        }
      }
      // And the pages: the lock screen and the app shell.
      clean("GET / (locked)", await (await app.fetch(new Request("http://localhost/"))).text());
      clean("GET / (open)", await (await app.fetch(new Request("http://localhost/", { headers: ui }))).text());
      clean("GET /authorize", await (await app.fetch(new Request(`http://localhost/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}`))).text());
    } finally {
      if (hadSupervisor === undefined) delete process.env.SUPERVISOR_TOKEN;
      else process.env.SUPERVISOR_TOKEN = hadSupervisor;
    }
  });
});
