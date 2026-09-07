/**
 * The screens a human sees before reaching the corpus: the OAuth consent page,
 * the owner lock screen, and the ingress deny page.
 *
 * They live together, apart from page.ts, for one reason — none of them may
 * DEPEND on client-side JavaScript. These are the surfaces where a failure
 * means "cannot get in at all", with no working UI left to debug against; a
 * plain form POST cannot be broken by a script error, a CSP, or a stray
 * newline in a template literal (which is exactly how page.ts's own client JS
 * broke once). The deny page carries the one script the PRD asks for (the
 * Copy-ID button, values set with `textContent`) and still reads correctly
 * with it disabled: the id is also rendered, escaped, in a `<noscript>`.
 */

import { escapeHtml } from "./utils";

const SHELL = `
  /*
    The same warm, lamp-lit world as the app — and now the same four themes.

    These screens were left on the old blue-slate palette when the app moved,
    which made the FIRST thing any visitor loads the one thing that did not look
    like the product. An entry screen that disagrees with what is behind it reads
    as two different pieces of software. The same argument applied again when the
    app gained themes and these screens did not: someone reading their corpus on
    \`paper\` pressed Lock and landed on a dark screen, and the light palette left
    here still carried the ember (#a2621d) the app had already moved off because
    it computes to 4.37:1 under the submit button's own text.

    So: the SAME token blocks as page.html, keyed the same way, read from the
    same __tn_theme key by the same pre-paint script (in shell() below).

    The @media block stays, unlike in the app — these screens must work with
    JavaScript off (that is the whole reason this file exists apart from
    page.ts), so the OS decides when nothing else can. A stored choice still
    wins: [data-theme] is (0,2,0) to the media block's (0,1,0), and a media
    query adds no specificity of its own.

    Ratios below are WCAG 2.1 on the sRGB hex, recomputed in test/theme.test.ts.
    The pairs these screens actually paint are ink/dim on ground and panel, and
    — the one the old light block failed — the submit button, which is
    --ground on --ember.
  */

  /* ember · ink 15.09/14.10 · dim 7.02/6.56 · ember 8.48/7.93 · clay 7.49/7.00
             · button (ground on ember) 8.48 */
  :root {
    --ground:#16130f; --panel:#1e1a15; --line:#312a22; --ink:#efe7da;
    --dim:#a99e8d; --ember:#e0a458; --clay:#e58e7c;
    --lamp: radial-gradient(50rem 20rem at 50% -6rem, rgba(224,164,88,.12), transparent 70%);
    --shadow-lamp: 0 1px 2px rgba(20,14,6,.20), 0 8px 24px -12px rgba(20,14,6,.45);
    color-scheme: dark;
  }
  /* daylight · ink 13.74/15.09 · dim 5.19/5.70 · ember 5.36/5.89 · clay 5.27/5.79
                · button 5.36 — was 4.37 with the old #a2621d */
  @media (prefers-color-scheme: light) {
    :root {
      --ground:#f7f2e7; --panel:#fffdf8; --line:#e6dcc8; --ink:#2b2419;
      --dim:#6f6453; --ember:#8f5615; --clay:#a5482f;
      --lamp: radial-gradient(50rem 20rem at 50% -6rem, rgba(143,86,21,.09), transparent 70%);
      --shadow-lamp: 0 1px 2px rgba(70,52,24,.08), 0 8px 24px -12px rgba(70,52,24,.22);
      color-scheme: light;
    }
  }
  :root[data-theme="ember"] {
    --ground:#16130f; --panel:#1e1a15; --line:#312a22; --ink:#efe7da;
    --dim:#a99e8d; --ember:#e0a458; --clay:#e58e7c;
    --lamp: radial-gradient(50rem 20rem at 50% -6rem, rgba(224,164,88,.12), transparent 70%);
    --shadow-lamp: 0 1px 2px rgba(20,14,6,.20), 0 8px 24px -12px rgba(20,14,6,.45);
    color-scheme: dark;
  }
  :root[data-theme="daylight"] {
    --ground:#f7f2e7; --panel:#fffdf8; --line:#e6dcc8; --ink:#2b2419;
    --dim:#6f6453; --ember:#8f5615; --clay:#a5482f;
    --lamp: radial-gradient(50rem 20rem at 50% -6rem, rgba(143,86,21,.09), transparent 70%);
    --shadow-lamp: 0 1px 2px rgba(70,52,24,.08), 0 8px 24px -12px rgba(70,52,24,.22);
    color-scheme: light;
  }
  /* slate · ink 13.18/11.75 · dim 7.05/6.29 · ember 8.43/7.51 · clay 6.53/5.83
           · button 8.43 */
  :root[data-theme="slate"] {
    --ground:#1b2430; --panel:#222d3a; --line:#34404f; --ink:#e7ecf2;
    --dim:#9fb0c2; --ember:#f0b35b; --clay:#f28b7d;
    --lamp: radial-gradient(50rem 20rem at 50% -6rem, rgba(240,179,91,.11), transparent 70%);
    --shadow-lamp: 0 1px 2px rgba(6,10,16,.28), 0 8px 24px -12px rgba(6,10,16,.50);
    color-scheme: dark;
  }
  /* paper · ink 16.15/17.27 · dim 5.68/6.07 · ember 5.06/5.41 · clay 5.86/6.27
           · button 5.06 */
  :root[data-theme="paper"] {
    --ground:#fbf7ee; --panel:#ffffff; --line:#e2d9c6; --ink:#1f1a14;
    --dim:#6b6152; --ember:#9a5b16; --clay:#a1432a;
    --lamp: radial-gradient(50rem 20rem at 50% -6rem, rgba(154,91,22,.08), transparent 70%);
    --shadow-lamp: 0 1px 2px rgba(52,44,28,.07), 0 8px 24px -12px rgba(52,44,28,.18);
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: var(--lamp), var(--ground); color: var(--ink); padding: 24px; }
  form { width: 100%; max-width: 26rem; background: var(--panel);
         border: 1px solid var(--line); border-radius: 14px; padding: 28px;
         box-shadow: var(--shadow-lamp); }
  h1 { font-size: 1.05rem; margin: 0 0 4px; letter-spacing: .01em; }
  p  { color: var(--dim); margin: 0 0 20px; font-size: .9rem; }
  .strong { color: var(--ink); font-weight: 600; }
  label { display: block; font-size: .8rem; color: var(--dim); margin-bottom: 6px; }
  input[type=password] { width: 100%; padding: 10px 12px; border-radius: 9px;
    border: 1px solid var(--line); background: var(--ground); color: var(--ink);
    font-size: .95rem; caret-color: var(--ember); }
  input[type=password]:focus { outline: none; border-color: color-mix(in oklab, var(--ember) 60%, var(--line));
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--ember) 22%, transparent); }
  button { margin-top: 16px; width: 100%; padding: 11px; border: 0; border-radius: 9px;
    background: var(--ember); color: var(--ground); font-size: .95rem; font-weight: 600;
    cursor: pointer; transition: filter .15s; }
  button:hover { filter: brightness(1.08); }
  .err { background: color-mix(in oklab, var(--clay) 14%, var(--panel));
         border: 1px solid color-mix(in oklab, var(--clay) 45%, var(--line));
         color: var(--clay); padding: 9px 12px; border-radius: 9px;
         font-size: .85rem; margin-bottom: 16px; }
  .meta { margin: 0 0 20px; font-size: .78rem; color: var(--dim); }
  .card { width: 100%; max-width: 26rem; background: var(--panel);
         border: 1px solid var(--line); border-radius: 14px; padding: 28px;
         box-shadow: var(--shadow-lamp); }
  .id { display: flex; gap: 8px; align-items: center; margin: 0 0 16px; }
  .id code { flex: 1; padding: 9px 12px; border-radius: 9px; background: var(--ground);
         border: 1px solid var(--line); font-size: .9rem; overflow-wrap: anywhere; }
  .id button { margin: 0; width: auto; padding: 9px 12px; }
  code.opt { color: var(--ember); }
  ::selection { background: color-mix(in oklab, var(--ember) 30%, transparent); color: var(--ink); }
  :focus-visible { outline: 2px solid var(--ember); outline-offset: 2px; }
`;

/**
 * The theme pre-paint, third copy (page.html's <head> and its app script hold
 * the other two). It is duplicated rather than shared for the same reason the
 * page's copy is: it must run with no bundler, no module, and no dependency,
 * before the stylesheet is parsed. test/theme.test.ts asserts all three copies
 * still name the same themes.
 *
 * Nothing here is required for these screens to work — with JS off the @media
 * block in SHELL decides, exactly as before. This only lets a person's stored
 * choice beat the operating system, so that pressing Lock from `paper` does not
 * land on a dark screen.
 *
 * `hasOwnProperty`, not `SCHEME[stored]`: a bare truthiness test on an object
 * literal accepts "constructor" and "__proto__" as theme names, and the shared
 * HA-ingress origin means a neighbour add-on can write this key.
 */
const PREPAINT = `
  (function () {
    var SCHEME = { ember: "dark", daylight: "light", slate: "dark", paper: "light" };
    var choice = "system";
    try {
      var stored = localStorage.getItem("__tn_theme");
      if (stored === "system" || Object.prototype.hasOwnProperty.call(SCHEME, stored)) choice = stored;
    } catch (e) {}
    if (choice === "system") return;   // leave the @media block in charge
    var root = document.documentElement;
    root.setAttribute("data-theme", choice);
    root.setAttribute("data-theme-choice", choice);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", SCHEME[choice]);
  })();
`;

const shell = (title: string, form: string): string => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="color-scheme" content="dark light">
<script>${PREPAINT}</script>
<style>${SHELL}</style></head>
<body>${form}</body></html>`;

/**
 * The OAuth consent screen — the only human step in the flow.
 *
 * There is no account system behind this: the owner passphrase IS the
 * authorization decision. Every OAuth parameter is echoed back as a hidden
 * field, because this form POSTs to /authorize and the code cannot be issued
 * without them.
 *
 * Honest, since trace-node (PRD §3.9 #5): digger printed only the
 * attacker-chosen `client_name`. This names the REDIRECT HOST the code will be
 * sent to, the client_id prefix, when it registered, and the scopes it asked
 * for — with `traces:read` as an unchecked checkbox (PRD §3.10), because the
 * log of who read what is not part of "read and write this corpus".
 */
export function approvalPage(input: {
  clientName: string;
  /** The host the authorization code will be redirected to. */
  redirectHost: string;
  clientId?: string;
  registeredAt?: string | null;
  /** The scopes carried forward as the hidden `scope` field — never `traces:read`. */
  params: Record<string, string>;
  error?: string;
  /** Ingress prefix, "" for a direct deploy — see ingressBase() in utils.ts. */
  base?: string;
}): string {
  const hidden = Object.entries(input.params)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join("");
  const registered = input.registeredAt ? ` · registered ${escapeHtml(input.registeredAt.slice(0, 16).replace("T", " "))}` : "";
  const prefix = input.clientId ? `client ${escapeHtml(input.clientId.slice(0, 8))}…` : "";

  return shell(
    "Authorize · trace-node",
    `<form method="post" action="${escapeHtml(input.base ?? "")}/authorize">
  <h1>Connect <span class="strong">${escapeHtml(input.clientName)}</span> → <span class="strong">${escapeHtml(input.redirectHost)}</span></h1>
  <p>It is asking to read and write this corpus. The code will be sent to <span class="strong">${escapeHtml(input.redirectHost)}</span>.</p>
  ${input.error ? `<div class="err">${escapeHtml(input.error)}</div>` : ""}
  <div class="meta">${prefix}${registered}</div>
  <div class="meta">Scope: ${escapeHtml(input.params.scope || "")}</div>
  <label class="meta"><input type="checkbox" name="traces_read" value="1"> Also let it read the trace log (<code>traces:read</code>: who sought what, per principal)</label>
  <label for="passphrase">Owner passphrase</label>
  <input id="passphrase" type="password" name="passphrase" autocomplete="current-password" autofocus required>
  ${hidden}
  <button type="submit">Approve</button>
</form>`,
  );
}

/**
 * The ingress deny page (PRD §8.1b "decided v0.4.1", research/ha-admin-lookup.md §4).
 *
 * Shown to a Home Assistant user who reached the panel through ingress and is
 * neither listed in `auto_login_ha_user_ids` nor (with `auto_login_ha_admins`
 * on) an admin. It says exactly what to do: copy this id, paste it into that
 * option. No passphrase form is offered — through ingress with auto-login on
 * there is none (PRD §3.9 #7) — and no token is minted.
 *
 * `user_id` and `user_name` are attacker-influenced strings (any HA account
 * can set its own display name), so they never touch `innerHTML`: the page
 * ships them as JSON in a `type="application/json"` block (`<` escaped so a
 * name cannot close the block) and the script sets `textContent`. The
 * `<noscript>` fallback is HTML-escaped the ordinary way.
 */
export function denyPage(input: {
  instanceName: string;
  userId: string;
  userName: string;
  /** The option name the id belongs in — `auto_login_ha_user_ids`. */
  allowlistOption: string;
}): string {
  const data = JSON.stringify({
    ok: false,
    user_id: input.userId,
    user_name: input.userName,
    allowlistOption: input.allowlistOption,
  }).replace(/</g, "\\u003c");
  return shell(
    `Not allowed · ${input.instanceName}`,
    `<div class="card">
  <h1>Not allowed</h1>
  <p>Home Assistant knows who you are, but this add-on has not been told to let you in.
  Add your user id to the option <code class="opt">${escapeHtml(input.allowlistOption)}</code> in the add-on's configuration, save, and reopen the panel.</p>
  <label>Home Assistant user <span id="deny-name"></span></label>
  <div class="id"><code id="deny-id"></code><button type="button" id="deny-copy">Copy ID</button></div>
  <noscript><p>Your user id: <code>${escapeHtml(input.userId)}</code>${input.userName ? ` (${escapeHtml(input.userName)})` : ""}</p></noscript>
  <p class="meta">Option: <code>${escapeHtml(input.allowlistOption)}</code> · nothing was signed in.</p>
  <script type="application/json" id="deny-data">${data}</script>
  <script>
    (function () {
      var deny = JSON.parse(document.getElementById("deny-data").textContent);
      var id = document.getElementById("deny-id");
      var name = document.getElementById("deny-name");
      id.textContent = deny.user_id;
      name.textContent = deny.user_name ? "(" + deny.user_name + ")" : "";
      var copy = document.getElementById("deny-copy");
      copy.addEventListener("click", function () {
        var done = function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy ID"; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(deny.user_id).then(done, function () { selectId(); });
        else selectId();
      });
      function selectId() {
        var range = document.createRange(); range.selectNodeContents(id);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      }
    })();
  </script>
</div>`,
  );
}

/**
 * The form-less refusal shown through Home Assistant ingress when auto-login
 * is on and the request could not be admitted — most often because Supervisor
 * forwarded no `X-Remote-User-Id` (nobody signed in to HA), or because the
 * request only claimed to be ingress (the header without the peer).
 *
 * PRD §3.9 #7: with `auto_login=true` the passphrase form is NOT offered
 * through ingress at all. So this page has no `<form>`, no password field,
 * nothing that could mint a cookie on HA's origin; it says why, and that
 * nothing was signed in. `message` is the server's own fixed text, never a
 * request value, but it is escaped anyway.
 */
export function ingressRefusedPage(input: { instanceName: string; message: string }): string {
  return shell(
    `Not signed in · ${input.instanceName}`,
    `<div class="card">
  <h1>Not signed in</h1>
  <p>${escapeHtml(input.message)}</p>
  <p class="meta">Sign in to Home Assistant and reopen the panel. No passphrase is asked for through the sidebar · nothing was signed in.</p>
</div>`,
  );
}

/** The lock screen for the web page. Same passphrase, different destination. */
export function loginPage(input: {
  instanceName: string;
  error?: string;
  next?: string;
  /** Ingress prefix, "" for a direct deploy — see ingressBase() in utils.ts. */
  base?: string;
}): string {
  return shell(
    `Sign in · ${input.instanceName}`,
    `<form method="post" action="${escapeHtml(input.base ?? "")}/login">
  <h1>${escapeHtml(input.instanceName)}</h1>
  <p>This corpus is private. Enter the owner passphrase.</p>
  ${input.error ? `<div class="err">${escapeHtml(input.error)}</div>` : ""}
  <label for="passphrase">Owner passphrase</label>
  <input id="passphrase" type="password" name="passphrase" autocomplete="current-password" autofocus required>
  ${input.next ? `<input type="hidden" name="next" value="${escapeHtml(input.next)}">` : ""}
  <button type="submit">Sign in</button>
</form>`,
  );
}
