/**
 * ha-admin.ts — the Supervisor-websocket admin lookup, against a FAKE Core.
 *
 * No live Supervisor is reachable from `bun test` (pre-ruling 2), so the wire
 * sequence is proven against an in-process `Bun.serve` websocket that speaks
 * exactly what Core speaks: `auth_required` → `auth` → `auth_ok` →
 * `config/auth/list` → `result`. The fake binds loopback on an ephemeral port
 * and prints the address it used. Ported from the p2p_dropbox add-on's tests
 * (oracle-haos-factory `lab/02-p2p-dropbox-kvmlab1`, commit 6b7dfd4) so the
 * behaviour is the one the browser-proven deny flow was measured against.
 */

import { expect, test } from "bun:test";

import { adminChecker, readAdminIds } from "../src/ha-admin";

/** One fake Core websocket. `users` is what `config/auth/list` answers. */
function fakeCore(options: { credential: string; users: unknown[]; commands?: string[]; silent?: boolean }) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, s) {
      if (s.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        if (!options.silent) ws.send(JSON.stringify({ type: "auth_required" }));
      },
      message(ws, data) {
        const m = JSON.parse(String(data));
        options.commands?.push(m.type);
        if (m.type === "auth") {
          ws.send(JSON.stringify(m.access_token === options.credential ? { type: "auth_ok" } : { type: "auth_invalid" }));
        } else {
          ws.send(JSON.stringify({ type: "result", id: m.id, success: true, result: options.users }));
        }
      },
    },
  });
  const url = `ws://127.0.0.1:${server.port}`;
  console.log(`ha-admin.test: fake Core websocket listening on ${url}`);
  return { server, url };
}

test("admin cache refreshes after 60s and fails closed instead of retaining stale grants", async () => {
  let now = 1000;
  let calls = 0;
  let fail = false;
  const check = adminChecker(
    async () => {
      calls++;
      if (fail) throw new Error("offline");
      return new Set(["admin"]);
    },
    () => now,
  );
  expect(await check("admin")).toBeTrue();
  expect(await check("user")).toBeFalse();
  expect(calls).toBe(1); // inside the minute: no second load
  now += 59_999;
  expect(await check("admin")).toBeTrue();
  expect(calls).toBe(1);
  now += 1; // the minute is up
  fail = true;
  expect(await check("admin")).toBeFalse(); // an outage denies, even a known admin
  expect(calls).toBe(2);
  now += 4999;
  expect(await check("admin")).toBeFalse(); // failure remembered 5 s, no retry storm
  expect(calls).toBe(2);
  now += 1;
  fail = false;
  expect(await check("admin")).toBeTrue();
  expect(calls).toBe(3);
});

test("concurrent callers during a refresh share ONE load", async () => {
  let calls = 0;
  const check = adminChecker(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return new Set(["a"]);
  });
  const answers = await Promise.all([check("a"), check("b"), check("a")]);
  expect(answers).toEqual([true, false, true]);
  expect(calls).toBe(1);
});

test("Core websocket uses only auth and config/auth/list; active owner/admin membership required", async () => {
  const credential = crypto.randomUUID();
  const commands: string[] = [];
  const { server, url } = fakeCore({
    credential,
    commands,
    users: [
      { id: "admin", is_active: true, group_ids: ["system-admin"] },
      { id: "owner", is_active: true, is_owner: true },
      { id: "inactive", is_active: false, group_ids: ["system-admin"] },
      { id: "user", is_active: true, group_ids: ["system-users"] },
      // a bare is_admin flag is not the permission system's source of truth
      { id: "flag-only", is_active: true, is_admin: true, group_ids: ["system-users"] },
      { id: 42, is_active: true, is_owner: true }, // not a string id
    ],
  });
  try {
    expect(await readAdminIds(url, credential)).toEqual(new Set(["admin", "owner"]));
    expect(commands).toEqual(["auth", "config/auth/list"]);
  } finally {
    server.stop(true);
  }
});

test("a refused auth, a malformed answer, a blank token and a silent Core all reject — never an empty grant set", async () => {
  await expect(readAdminIds("ws://127.0.0.1:1", "")).rejects.toThrow("credentials");

  const refused = fakeCore({ credential: "right", users: [] });
  try {
    await expect(readAdminIds(refused.url, "wrong")).rejects.toThrow("unavailable");
  } finally {
    refused.server.stop(true);
  }

  const malformed = fakeCore({ credential: "c", users: "not-a-list" as unknown as unknown[] });
  try {
    await expect(readAdminIds(malformed.url, "c")).rejects.toThrow("unavailable");
  } finally {
    malformed.server.stop(true);
  }

  const silent = fakeCore({ credential: "c", users: [], silent: true });
  try {
    await expect(readAdminIds(silent.url, "c", 30)).rejects.toThrow("unavailable");
  } finally {
    silent.server.stop(true);
  }
});
