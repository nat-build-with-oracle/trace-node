/**
 * The 2026-07-28 stack (PRD §8.1b 1b-mcp2026), rule by rule, and the
 * compatibility matrix rows that matter to this fleet: a legacy client is
 * unaffected, a modern client gets `resultType` and `server/discover`.
 *
 * Wire reference: research/mcp-2026-07-28-wire.md (spec pages fetched
 * 2026-09-07). Every request here is built by hand — the `_meta` keys and the
 * three headers are the whole point, so no helper hides them.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createApp } from "../src/app";
import { IMPLEMENTED_PROTOCOL_VERSIONS, LEGACY_PROTOCOL_VERSIONS, MCP_ERRORS, META, MODERN_PROTOCOL_VERSIONS } from "../src/mcp";
import { openSqliteStore } from "../src/store/sqlite";
import type { Store } from "../src/store/types";

const migrations = readdirSync(join(import.meta.dir, "..", "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({ name: file, sql: readFileSync(join(import.meta.dir, "..", "migrations", file), "utf8") }));

const V = "2026-07-28";
const PV = `${META}protocolVersion`;
const CAPS = `${META}clientCapabilities`;
const INFO = `${META}clientInfo`;
const SERVER = `${META}serverInfo`;

let store: Store;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  store = await openSqliteStore(":memory:", migrations);
  app = createApp({ store, instanceName: "test" });
});

/** A well-formed modern `_meta`, overridable per test. */
const meta = (over: Record<string, unknown> = {}) => ({
  [PV]: V,
  [INFO]: { name: "modern-test", version: "1.0.0" },
  [CAPS]: {},
  ...over,
});

interface Wire {
  method: string;
  params?: Record<string, unknown>;
  id?: string | number | null;
  headers?: Record<string, string>;
  /** Drop one of the mirrored headers to test the "required" branch. */
  omit?: Array<"MCP-Protocol-Version" | "Mcp-Method" | "Mcp-Name">;
  token?: string;
  target?: ReturnType<typeof createApp>;
}

/** POST /mcp with the headers a spec-following 2026-07-28 client sends. */
const modern = async (wire: Wire) => {
  const { method, params, headers = {}, omit = [], token, target } = wire;
  // `id: undefined` given explicitly means "a notification" — no id at all.
  const id = "id" in wire ? wire.id : "m-1";
  const version = (params?._meta as any)?.[PV];
  const name = params?.name ?? params?.uri;
  const h: Record<string, string> = { "content-type": "application/json" };
  if (typeof version === "string" && !omit.includes("MCP-Protocol-Version")) h["MCP-Protocol-Version"] = version;
  if (!omit.includes("Mcp-Method")) h["Mcp-Method"] = method;
  if (typeof name === "string" && !omit.includes("Mcp-Name")) h["Mcp-Name"] = name;
  if (token) h.authorization = `Bearer ${token}`;
  Object.assign(h, headers);
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (id !== undefined) body.id = id;
  const response = await (target ?? app).fetch(
    new Request("http://localhost/mcp", { method: "POST", headers: h, body: JSON.stringify(body) }),
  );
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, body: json, text };
};

/** A bare legacy request, exactly as gate 1a's tests send them: no headers, no `_meta`. */
const legacy = async (method: string, params: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) => {
  const response = await app.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return { status: response.status, body: (await response.json()) as any };
};

const toolText = (body: any) => JSON.parse(body.result.content[0].text);

describe("mcp 2026-07-28", () => {
  // ── (1) server/discover ─────────────────────────────────────────────────
  test("server/discover answers a DiscoverResult: resultType, supportedVersions, capabilities, _meta.serverInfo, instructions, ttlMs, cacheScope", async () => {
    const { status, body } = await modern({ method: "server/discover", params: { _meta: meta() } });
    expect(status).toBe(200);
    expect(body.id).toBe("m-1");
    const r = body.result;
    expect(r.resultType).toBe("complete");
    expect(r.supportedVersions).toEqual([V]);
    expect(r.capabilities).toEqual({ tools: {} });
    expect(r._meta[SERVER].name).toBe("trace-node");
    expect(typeof r._meta[SERVER].version).toBe("string");
    expect(r.instructions).toContain("dig");
    expect(r.ttlMs).toBeGreaterThan(0);
    expect(r.cacheScope).toBe("public");
    expect(Object.keys(r).sort()).toEqual(["_meta", "cacheScope", "capabilities", "instructions", "resultType", "supportedVersions", "ttlMs"]);
  });

  test("server/discover takes no params beyond _meta → 400 / -32602 naming the extras", async () => {
    const { status, body } = await modern({ method: "server/discover", params: { _meta: meta(), protocolVersion: V } });
    expect(status).toBe(400);
    expect(body.error.code).toBe(MCP_ERRORS.InvalidParams);
    expect(body.error.data.extra).toEqual(["protocolVersion"]);
  });

  test("server/discover is a modern-only method: sent bare (no _meta, no headers) it is 400 / -32602, never processed as legacy", async () => {
    const { status, body } = await legacy("server/discover");
    expect(status).toBe(400);
    expect(body.error.code).toBe(MCP_ERRORS.InvalidParams);
    expect(body.error.data.missing).toEqual([PV]);
  });

  // ── (2) _meta handling ──────────────────────────────────────────────────
  test("_meta without protocolVersion (clientCapabilities alone) → 400 / -32602, routed modern by the reserved key", async () => {
    const { status, body } = await modern({ method: "tools/list", params: { _meta: { [CAPS]: {} } }, headers: { "MCP-Protocol-Version": V } });
    expect(status).toBe(400);
    expect(body.error.code).toBe(MCP_ERRORS.InvalidParams);
    expect(body.error.message).toContain(PV);
  });

  test("_meta without clientCapabilities → 400 / -32602", async () => {
    const { status, body } = await modern({ method: "tools/list", params: { _meta: { [PV]: V, [INFO]: { name: "x", version: "0" } } } });
    expect(status).toBe(400);
    expect(body.error.code).toBe(MCP_ERRORS.InvalidParams);
    expect(body.error.data.missing).toEqual([CAPS]);
  });

  test("clientInfo is SHOULD and logLevel optional: both absent still answers; a non-object clientInfo is -32602", async () => {
    const bare = await modern({ method: "ping", params: { _meta: { [PV]: V, [CAPS]: {} } } });
    expect(bare.status).toBe(200);
    expect(bare.body.result.resultType).toBe("complete");
    const level = await modern({ method: "ping", params: { _meta: meta({ [`${META}logLevel`]: "debug" }) } });
    expect(level.status).toBe(200);
    const broken = await modern({ method: "ping", params: { _meta: meta({ [INFO]: "not-an-object" }) } });
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe(MCP_ERRORS.InvalidParams);
  });

  test("every result echoes serverInfo in _meta (display-only, not a negotiated version)", async () => {
    for (const method of ["ping", "tools/list", "server/discover"]) {
      const { body } = await modern({ method, params: { _meta: meta() } });
      expect(body.result._meta).toEqual({ [SERVER]: { name: "trace-node", version: body.result._meta[SERVER].version } });
      expect(body.result._meta[SERVER].version).toMatch(/\d/);
    }
  });

  // ── (3) the headers ─────────────────────────────────────────────────────
  test("missing MCP-Protocol-Version header → 400 / -32020 HeaderMismatch, data names the header", async () => {
    const { status, body } = await modern({ method: "tools/list", params: { _meta: meta() }, omit: ["MCP-Protocol-Version"] });
    expect(status).toBe(400);
    expect(body.error.code).toBe(MCP_ERRORS.HeaderMismatch);
    expect(body.error.message).toContain("HeaderMismatch");
    expect(body.error.data).toEqual({ header: "MCP-Protocol-Version", expected: V, got: null });
  });

  test("MCP-Protocol-Version header ≠ body _meta value → 400 / -32020", async () => {
    const { status, body } = await modern({ method: "tools/list", params: { _meta: meta() }, headers: { "MCP-Protocol-Version": "2025-11-25" } });
    expect(status).toBe(400);
    expect(body.error.code).toBe(MCP_ERRORS.HeaderMismatch);
    expect(body.error.data).toEqual({ header: "MCP-Protocol-Version", expected: V, got: "2025-11-25" });
  });

  test("an unsupported modern version (header and body agree) → 400 / -32022 with the supported list, and it is logged as seen", async () => {
    const { status, body } = await modern({ method: "tools/list", params: { _meta: meta({ [PV]: "2027-01-01" }) } });
    expect(status).toBe(400);
    expect(body.error.code).toBe(MCP_ERRORS.UnsupportedProtocolVersion);
    expect(body.error.data).toEqual({ requested: "2027-01-01", supported: [V] });
    const health = (await (await app.fetch(new Request("http://localhost/api/health"))).json()) as any;
    expect(health.protocol_versions_seen).toEqual(["2027-01-01"]);
  });

  test("a legacy revision in modern _meta (2025-11-25) is -32022, never processed under legacy semantics — the two eras do not mix", async () => {
    const { status, body } = await modern({ method: "tools/list", params: { _meta: meta({ [PV]: "2025-11-25" }) } });
    expect(status).toBe(400);
    expect(body.error.code).toBe(MCP_ERRORS.UnsupportedProtocolVersion);
    expect(body.error.data.supported).toEqual([V]);
  });

  test("missing Mcp-Method → 400 / -32020", async () => {
    const { status, body } = await modern({ method: "tools/list", params: { _meta: meta() }, omit: ["Mcp-Method"] });
    expect(status).toBe(400);
    expect(body.error.code).toBe(MCP_ERRORS.HeaderMismatch);
    expect(body.error.data).toEqual({ header: "Mcp-Method", expected: "tools/list", got: null });
  });

  test("Mcp-Method ≠ method → 400 / -32020; header names are case-insensitive, values are not", async () => {
    const wrong = await modern({ method: "tools/list", params: { _meta: meta() }, headers: { "Mcp-Method": "ping" } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe(MCP_ERRORS.HeaderMismatch);
    expect(wrong.body.error.data.got).toBe("ping");
    const cased = await modern({ method: "tools/list", params: { _meta: meta() }, headers: { "Mcp-Method": "Tools/List" } });
    expect(cased.status).toBe(400);
    expect(cased.body.error.code).toBe(MCP_ERRORS.HeaderMismatch);
    const lower = await modern({ method: "tools/list", params: { _meta: meta() }, omit: ["Mcp-Method"], headers: { "mcp-method": "tools/list" } });
    expect(lower.status).toBe(200);
  });

  test("tools/call without Mcp-Name → 400 / -32020; Mcp-Name ≠ params.name → 400 / -32020", async () => {
    const missing = await modern({ method: "tools/call", params: { _meta: meta(), name: "status", arguments: {} }, omit: ["Mcp-Name"] });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe(MCP_ERRORS.HeaderMismatch);
    expect(missing.body.error.data).toEqual({ header: "Mcp-Name", expected: "status", got: null });
    const wrong = await modern({ method: "tools/call", params: { _meta: meta(), name: "status", arguments: {} }, headers: { "Mcp-Name": "dig" } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe(MCP_ERRORS.HeaderMismatch);
    expect(wrong.body.error.data).toEqual({ header: "Mcp-Name", expected: "status", got: "dig" });
  });

  test("Mcp-Name accepts the =?base64?…?= sentinel and compares the decoded value", async () => {
    const encoded = `=?base64?${btoa("status")}?=`;
    const okay = await modern({ method: "tools/call", params: { _meta: meta(), name: "status", arguments: {} }, headers: { "Mcp-Name": encoded } });
    expect(okay.status).toBe(200);
    expect(okay.body.result.resultType).toBe("complete");
    const other = await modern({ method: "tools/call", params: { _meta: meta(), name: "status", arguments: {} }, headers: { "Mcp-Name": `=?base64?${btoa("dig")}?=` } });
    expect(other.status).toBe(400);
    expect(other.body.error.code).toBe(MCP_ERRORS.HeaderMismatch);
  });

  test("Mcp-Name is not demanded on tools/list or ping", async () => {
    const list = await modern({ method: "tools/list", params: { _meta: meta() } });
    expect(list.status).toBe(200);
    const ping = await modern({ method: "ping", params: { _meta: meta() } });
    expect(ping.status).toBe(200);
  });

  test("the checks run in the PRD's order: _meta before headers, headers before the method", async () => {
    // No protocolVersion AND no headers AND an unknown method: -32602 wins.
    const noMeta = await modern({ method: "nope/nothing", params: { _meta: { [CAPS]: {} } }, omit: ["Mcp-Method"] });
    expect(noMeta.body.error.code).toBe(MCP_ERRORS.InvalidParams);
    // protocolVersion present, header missing, unknown method: -32020 wins over -32601.
    const noHeader = await modern({ method: "nope/nothing", params: { _meta: meta() }, omit: ["MCP-Protocol-Version"] });
    expect(noHeader.body.error.code).toBe(MCP_ERRORS.HeaderMismatch);
    // Everything in place, unknown method: 404 / -32601.
    const unknown = await modern({ method: "nope/nothing", params: { _meta: meta() } });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe(MCP_ERRORS.MethodNotFound);
  });

  // ── (4) error renumbering ───────────────────────────────────────────────
  test("the error table is the 2026-07-28 one: -32020 HeaderMismatch, -32021 MissingRequiredClientCapability, -32022 UnsupportedProtocolVersion, resource-not-found -32602", () => {
    expect(MCP_ERRORS.HeaderMismatch).toBe(-32020);
    expect(MCP_ERRORS.MissingRequiredClientCapability).toBe(-32021);
    expect(MCP_ERRORS.UnsupportedProtocolVersion).toBe(-32022);
    expect(MCP_ERRORS.ResourceNotFound).toBe(-32602);
    expect(MCP_ERRORS.InvalidParams).toBe(-32602);
    // Nothing in the frozen legacy range is emitted by the modern stack.
    for (const code of Object.values(MCP_ERRORS)) expect(code > -32020 && code <= -32000).toBe(false);
  });

  test("resources/read and prompts/get are not served: 404 / -32601, never the old -32002", async () => {
    const res = await modern({ method: "resources/read", params: { _meta: meta(), uri: "trace://nothing" } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(MCP_ERRORS.MethodNotFound);
    const prompt = await modern({ method: "prompts/get", params: { _meta: meta(), name: "nothing" } });
    expect(prompt.status).toBe(404);
    expect(prompt.body.error.code).toBe(-32601);
  });

  // ── (5) resultType on every result ──────────────────────────────────────
  test("tools/list is a CacheableResult: resultType, ttlMs, cacheScope, 23 tools in a deterministic order", async () => {
    const a = await modern({ method: "tools/list", params: { _meta: meta() } });
    const b = await modern({ method: "tools/list", params: { _meta: meta() }, id: "m-2" });
    expect(a.status).toBe(200);
    expect(a.body.result.resultType).toBe("complete");
    expect(a.body.result.ttlMs).toBeGreaterThan(0);
    expect(a.body.result.cacheScope).toBe("public");
    expect(a.body.result.tools).toHaveLength(23);
    expect(a.body.result.tools.map((t: any) => t.name)).toEqual(b.body.result.tools.map((t: any) => t.name));
  });

  test("tools/call returns resultType complete around the same content shape as the legacy stack", async () => {
    const created = await modern({
      method: "tools/call",
      params: { _meta: meta(), name: "node_create", arguments: { title: "modern node", body: "made by a 2026-07-28 client", terms: ["tags:modern"] } },
    });
    expect(created.status).toBe(200);
    expect(created.body.result.resultType).toBe("complete");
    expect(created.body.result.content[0].type).toBe("text");
    expect(created.body.result.isError).toBeUndefined();
    const node = toolText(created.body);
    expect(node.title).toBe("modern node");
    expect(node.terms.map((t: any) => t.name)).toEqual(["modern"]);
    expect(Object.keys(created.body.result).sort()).toEqual(["_meta", "content", "resultType"]);
  });

  test("ping answers {resultType, _meta} and nothing else", async () => {
    const { body } = await modern({ method: "ping", params: { _meta: meta() } });
    expect(Object.keys(body.result).sort()).toEqual(["_meta", "resultType"]);
  });

  test("a tool failure stays inside the result (isError) with resultType complete — a protocol error is not how a model learns why", async () => {
    const { status, body } = await modern({ method: "tools/call", params: { _meta: meta(), name: "no_such_tool", arguments: {} } });
    expect(status).toBe(200);
    expect(body.result.resultType).toBe("complete");
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("unknown tool");
  });

  test("a modern dig is a real dig: dig_seq, a kind=dig trace row, and the call log labels the client from _meta.clientInfo", async () => {
    await modern({ method: "tools/call", params: { _meta: meta(), name: "node_create", arguments: { title: "keyword modern-dig" } }, id: 1 });
    const dug = await modern({ method: "tools/call", params: { _meta: meta(), name: "dig", arguments: { keyword: "modern-dig" } }, id: 2 });
    expect(dug.status).toBe(200);
    expect(dug.body.result.resultType).toBe("complete");
    expect(toolText(dug.body).dig_seq).toBe(1);
    const traces = (await (await app.fetch(new Request("http://localhost/api/traces"))).json()) as any;
    expect(traces.traces.filter((t: any) => t.kind === "dig" && t.keyword_norm === "modern-dig")).toHaveLength(1);
    const calls = (await (await app.fetch(new Request("http://localhost/api/calls?tool=dig"))).json()) as any;
    expect(calls.calls[0].client).toBe("modern-test");
  });

  test("notifications on the modern path: 202 after the header checks, 400 / -32020 without them", async () => {
    const fine = await modern({ method: "notifications/cancelled", params: { _meta: meta(), requestId: "m-1" }, id: undefined });
    expect(fine.status).toBe(202);
    expect(fine.text).toBe("");
    const bare = await modern({ method: "notifications/cancelled", params: { _meta: meta(), requestId: "m-1" }, id: undefined, omit: ["Mcp-Method"] });
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe(MCP_ERRORS.HeaderMismatch);
    expect(bare.body.id).toBeNull();
  });

  // ── (6) route by presence — never mix ───────────────────────────────────
  test("initialize carrying a modern _meta is the mixed request the PRD forbids: 404 / -32601", async () => {
    const { status, body } = await modern({ method: "initialize", params: { _meta: meta(), protocolVersion: V, capabilities: {} } });
    expect(status).toBe(404);
    expect(body.error.code).toBe(MCP_ERRORS.MethodNotFound);
  });

  test("an MCP-Protocol-Version: 2026-07-28 header with no _meta is a modern claim without a body to back it: 400 / -32602", async () => {
    const { status, body } = await legacy("tools/list", {}, { "MCP-Protocol-Version": V, "Mcp-Method": "tools/list" });
    expect(status).toBe(400);
    expect(body.error.code).toBe(MCP_ERRORS.InvalidParams);
    expect(body.error.data.missing).toEqual([PV]);
  });

  // ── compatibility matrix: legacy client unaffected ──────────────────────
  test("matrix — legacy client, dual-era server: bare initialize still works, 2026-07-28 asked over initialize still negotiates down to 2025-11-25", async () => {
    for (const [asked, want] of [
      ["2025-11-25", "2025-11-25"],
      ["2025-06-18", "2025-06-18"],
      [V, "2025-11-25"],
      ["banana", "2025-11-25"],
    ]) {
      const { status, body } = await legacy("initialize", { protocolVersion: asked, capabilities: {}, clientInfo: { name: "legacy" } });
      expect(status).toBe(200);
      expect(body.result.protocolVersion).toBe(want);
      expect(body.result.serverInfo.name).toBe("trace-node");
      expect(body.result.resultType).toBeUndefined();
    }
  });

  test("matrix — legacy results are byte-for-byte gate 1a's: no resultType, no _meta, no ttlMs; unknown method stays 200 / -32601", async () => {
    const list = await legacy("tools/list");
    expect(list.status).toBe(200);
    expect(Object.keys(list.body.result)).toEqual(["tools"]);
    expect(list.body.result.tools).toHaveLength(23);
    const ping = await legacy("ping");
    expect(ping.body.result).toEqual({});
    const call = await legacy("tools/call", { name: "status", arguments: {} });
    expect(Object.keys(call.body.result)).toEqual(["content"]);
    const unknown = await legacy("nope/nothing");
    expect(unknown.status).toBe(200);
    expect(unknown.body.error.code).toBe(-32601);
  });

  test("matrix — a 2025-06-18+ legacy client that sends MCP-Protocol-Version: 2025-11-25 with no _meta stays on the legacy path", async () => {
    const { status, body } = await legacy("tools/list", {}, { "MCP-Protocol-Version": "2025-11-25" });
    expect(status).toBe(200);
    expect(Object.keys(body.result)).toEqual(["tools"]);
    // and a client that sends the header but forgets Mcp-Method is still legacy — the legacy stack never reads headers
    const noMethod = await legacy("ping", {}, { "MCP-Protocol-Version": "2025-06-18" });
    expect(noMethod.status).toBe(200);
  });

  test("matrix — modern client, dual-era server: discover, then tools/list, then a call, all with resultType; the legacy log sees the same version once", async () => {
    const discover = await modern({ method: "server/discover", params: { _meta: meta() }, id: "d" });
    const list = await modern({ method: "tools/list", params: { _meta: meta() }, id: "l" });
    const call = await modern({ method: "tools/call", params: { _meta: meta(), name: "status", arguments: {} }, id: "c" });
    expect([discover.status, list.status, call.status]).toEqual([200, 200, 200]);
    expect([discover.body.result.resultType, list.body.result.resultType, call.body.result.resultType]).toEqual(["complete", "complete", "complete"]);
    expect(toolText(call.body).tools).toBe(23);
    const health = (await (await app.fetch(new Request("http://localhost/api/health"))).json()) as any;
    expect(health.protocol_versions_seen).toEqual([V]);
  });

  test("the gate runs before the era: a modern request without a credential is 401 with the challenge, with the api token it is served", async () => {
    const gated = createApp({ store, instanceName: "test", auth: { apiToken: "static-token-for-modern" } });
    const denied = await modern({ method: "server/discover", params: { _meta: meta() }, target: gated });
    expect(denied.status).toBe(401);
    const served = await modern({ method: "server/discover", params: { _meta: meta() }, target: gated, token: "static-token-for-modern" });
    expect(served.status).toBe(200);
    expect(served.body.result.supportedVersions).toEqual([V]);
  });

  // ── (7) the version lists ───────────────────────────────────────────────
  test("MODERN_PROTOCOL_VERSIONS is exactly what discover advertises and -32022 names", async () => {
    expect(MODERN_PROTOCOL_VERSIONS).toEqual([V]);
    const { body } = await modern({ method: "server/discover", params: { _meta: meta() } });
    expect(body.result.supportedVersions).toEqual(MODERN_PROTOCOL_VERSIONS);
    const unlisted = await modern({ method: "ping", params: { _meta: meta({ [PV]: "2099-01-01" }) } });
    expect(unlisted.body.error.data.supported).toEqual(MODERN_PROTOCOL_VERSIONS);
  });

  test("(7) 2026-07-28 now leads IMPLEMENTED_PROTOCOL_VERSIONS — and a legacy initialize still never hears it", async () => {
    expect(IMPLEMENTED_PROTOCOL_VERSIONS[0]).toBe(V);
    expect(IMPLEMENTED_PROTOCOL_VERSIONS).toEqual([V, ...LEGACY_PROTOCOL_VERSIONS]);
    expect(LEGACY_PROTOCOL_VERSIONS).toEqual(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
    expect(LEGACY_PROTOCOL_VERSIONS).not.toContain(V);
    // The legacy stack answers from LEGACY only: asking for the modern revision
    // over `initialize` is a legacy client whatever it names, and hears 2025-11-25.
    const asked = await legacy("initialize", { protocolVersion: V });
    expect(asked.body.result.protocolVersion).toBe("2025-11-25");
    const unknown = await legacy("initialize", { protocolVersion: "2099-01-01" });
    expect(unknown.body.result.protocolVersion).toBe("2025-11-25");
    for (const v of LEGACY_PROTOCOL_VERSIONS) {
      expect((await legacy("initialize", { protocolVersion: v })).body.result.protocolVersion).toBe(v);
    }
  });
});
