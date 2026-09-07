/**
 * Themes: the page's token contract, its no-flash boot, and its contrast floor.
 *
 * The page is client-rendered, so what the SERVER can prove is the shell — and
 * the shell is where every part of theming that can silently rot actually
 * lives:
 *
 *   1. the token blocks — a theme that forgets one token does not fail, it
 *      inherits the previous theme's value for that one thing, which is the
 *      kind of bug you see three weeks later in a screenshot;
 *   2. the pre-paint script's position — one line further down the file and the
 *      no-flash guarantee is gone with no error anywhere;
 *   3. the three lists of theme names (the CSS blocks, the pre-paint script's
 *      own copy, and the app's THEMES) — the script is duplicated on purpose,
 *      so drift between the copies is the failure this file exists to catch;
 *   4. the contrast, RECOMPUTED from the CSS text rather than trusted from the
 *      comment above each block. A ratio written by hand is a claim; a ratio
 *      derived from the shipped hex is a measurement.
 */

import { describe, expect, test } from "bun:test";

import { page } from "../src/page";
import { denyPage, loginPage } from "../src/screens";

const html = page("themes");

// The one <style> element. Taken by match rather than indexOf because the words
// "<style>" written in a comment above it would silently move the slice — which
// is exactly what happened once while this file was being written.
const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
const style = styles[0] ?? "";
/** The stylesheet with its comments removed — what the browser actually acts on. */
const css = style.replace(/\/\*[\s\S]*?\*\//g, "");

/** The four named blocks, plus the bare `:root` default, as token maps. */
function themeBlocks(css: string): Map<string, Record<string, string>> {
  const blocks = new Map<string, Record<string, string>>();
  for (const match of css.matchAll(/:root(?:\[data-theme="([a-z]+)"\])?\s*\{([^}]*)\}/g)) {
    const tokens: Record<string, string> = {};
    for (const decl of match[2]!.matchAll(/--([a-z-]+)\s*:\s*([^;]+);/g)) {
      tokens[decl[1]!] = decl[2]!.trim();
    }
    tokens["color-scheme"] = (/color-scheme\s*:\s*([a-z]+)/.exec(match[2]!) ?? [])[1] ?? "";
    blocks.set(match[1] ?? "default", tokens);
  }
  return blocks;
}

const blocks = themeBlocks(style);
const NAMED = ["ember", "daylight", "slate", "paper"];

// WCAG 2.1 relative luminance and contrast, on the sRGB hex the page ships.
const channels = (hex: string): number[] => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const luminance = (hex: string): number => {
  const [r, g, b] = channels(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("themes: the token blocks", () => {
  test("the page has exactly one stylesheet, and this file is reading it", () => {
    expect(styles.length).toBe(1);
    expect(style).not.toContain("<script");
    expect(style).toContain(":root {");
  });

  test("five blocks — the default and four named — and no media query deciding for anyone", () => {
    expect([...blocks.keys()]).toEqual(["default", ...NAMED]);

    // The @media (prefers-color-scheme: light) block is GONE from the CSS: the
    // pre-paint script resolves `system` instead. A media query cannot be
    // overruled by a person, so leaving it in would mean a chosen light theme
    // still flipping with the OS.
    expect(css).not.toContain("prefers-color-scheme");
    for (const name of NAMED) expect(css).toContain(`:root[data-theme="${name}"]`);
  });

  test("every theme defines every token the default defines", () => {
    const expected = Object.keys(blocks.get("default")!).sort();
    // Ten colour tokens, the lamp gradient, the shadow tint, and color-scheme.
    expect(expected).toEqual(
      ["chip", "clay", "color-scheme", "dim", "ember", "ground", "ink", "lamp", "line", "panel", "sage", "shadow-lamp"],
    );
    for (const name of NAMED) {
      expect(Object.keys(blocks.get(name)!).sort()).toEqual(expected);
      for (const token of expected) expect(blocks.get(name)![token]).toBeTruthy();
    }
  });

  test("the default block IS ember — a page whose script never ran keeps the identity", () => {
    expect(blocks.get("default")).toEqual(blocks.get("ember")!);
  });

  test("each theme declares the color-scheme it actually is", () => {
    expect(blocks.get("ember")!["color-scheme"]).toBe("dark");
    expect(blocks.get("slate")!["color-scheme"]).toBe("dark");
    expect(blocks.get("daylight")!["color-scheme"]).toBe("light");
    expect(blocks.get("paper")!["color-scheme"]).toBe("light");
  });

  test("no colour is hardcoded outside a token block", () => {
    const outside = css.replace(/:root(?:\[data-theme="[a-z]+"\])?\s*\{[^}]*\}/g, "");
    expect(outside).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(outside).not.toMatch(/\brgba?\(/);
  });
});

describe("themes: contrast", () => {
  // What the page actually paints text on: the body ground, a panel, a chip.
  const GROUNDS = ["ground", "panel", "chip"];
  const TEXT = ["ink", "dim", "ember", "sage", "clay"];

  test("the helper agrees with the two anchors of the scale", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  test.each(NAMED)("%s: every text token clears 4.5:1 on every ground", (name) => {
    const tokens = blocks.get(name)!;
    for (const fg of TEXT) {
      for (const bg of GROUNDS) {
        const ratio = contrast(tokens[fg]!, tokens[bg]!);
        // Named in the message so a failure says which pair and by how much.
        expect(`${name} ${fg}-on-${bg} ${ratio.toFixed(2)}`).toBe(
          `${name} ${fg}-on-${bg} ${Math.max(ratio, 4.5).toFixed(2)}`,
        );
      }
    }
  });

  // The other direction, which the matrix above cannot see: the page's filled
  // controls paint the GROUND on an accent — `bg-ember text-ground` on the Dig
  // button, the two settings submits, the consent Allow, the panel action. A
  // text token that stays legible as text can still be a button fill nobody can
  // read, and paper's ground-on-sage (4.84) is the tightest pair on the page.
  const FILLS = ["ember", "sage", "clay"];

  test("the filled controls really are ground-on-accent, or this matrix is guarding nothing", () => {
    const filled = [...html.matchAll(/class="[^"]*\bbg-(ember|sage|clay)\b[^"]*"/g)]
      .filter((m) => m[0]!.includes("text-ground"))
      .map((m) => m[1]!);
    expect(filled.length).toBeGreaterThan(0);
    for (const fill of new Set(filled)) expect(FILLS).toContain(fill);
  });

  test.each(NAMED)("%s: the ground clears 4.5:1 on every accent it is painted on", (name) => {
    const tokens = blocks.get(name)!;
    for (const fill of FILLS) {
      const ratio = contrast(tokens["ground"]!, tokens[fill]!);
      expect(`${name} ground-on-${fill} ${ratio.toFixed(2)}`).toBe(
        `${name} ground-on-${fill} ${Math.max(ratio, 4.5).toFixed(2)}`,
      );
    }
  });

  test("the ratios written above each block are the measured ones", () => {
    // The comments are documentation that can rot; this pins them to the hex.
    for (const name of NAMED) {
      const tokens = blocks.get(name)!;
      const comment = style.slice(0, style.indexOf(`:root[data-theme="${name}"]`)).split("/*").pop()!;
      for (const fg of TEXT) {
        const row = new RegExp(`^\\s*${fg}\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`, "m").exec(comment);
        expect(`${name} ${fg} row`).toBe(row ? `${name} ${fg} row` : `${name} ${fg} row MISSING`);
        GROUNDS.forEach((bg, i) => {
          expect(`${name} ${fg}/${bg} ${row![i + 1]}`).toBe(
            `${name} ${fg}/${bg} ${contrast(tokens[fg]!, tokens[bg]!).toFixed(2)}`,
          );
        });
      }
    }
  });
});

describe("themes: the pre-paint script", () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const prepaint = scripts.find((s) => s.includes("__tn_theme") && !s.includes("const BASE"))!;

  test("it runs before the stylesheet, so a reload cannot flash the wrong ground", () => {
    expect(prepaint).toBeDefined();
    expect(html.indexOf(prepaint)).toBeLessThan(html.indexOf("<style>"));
    // …and before the CDN scripts, so it cannot be delayed by a slow network.
    expect(html.indexOf(prepaint)).toBeLessThan(html.indexOf("cdn.tailwindcss.com"));
  });

  test("it sets data-theme on <html> and keeps <meta name=color-scheme> in step", () => {
    expect(prepaint).toContain('setAttribute("data-theme"');
    expect(prepaint).toContain('meta[name="color-scheme"]');
    expect(html).toContain('<meta name="color-scheme"');
    // Storage and matchMedia are both guarded: a private window that throws on
    // localStorage must still paint.
    expect(prepaint.match(/try \{/g)?.length).toBeGreaterThanOrEqual(2);
    expect(prepaint).toContain("localStorage.getItem(\"__tn_theme\")");
  });

  test("a stored value is checked against the OWN keys, not the prototype chain", () => {
    // `if (SCHEME[stored])` accepts "constructor", "toString" and "__proto__"
    // as theme names: the page then paints data-theme="constructor", which no
    // block matches, and writes `function Object() { [native code] }` into the
    // meta. The app copy self-heals on hydration — but only if the CDN scripts
    // arrive, so the wrong first paint is permanent when they do not.
    expect(prepaint).toContain("Object.prototype.hasOwnProperty.call(SCHEME, stored)");
    expect(prepaint).not.toMatch(/\|\|\s*SCHEME\[stored\]\s*\)/);
    // The app's own copy tests membership against the literal list instead.
    const app = scripts.find((s) => s.includes("const BASE"))!;
    expect(app).toContain("THEMES.includes(stored)");
  });

  test("its theme list has not drifted from the CSS or from the app", () => {
    const inPrepaint = [...prepaint.matchAll(/(\w+): "(dark|light)"/g)].map((m) => m[1]!);
    expect(inPrepaint.sort()).toEqual([...NAMED].sort());

    const app = scripts.find((s) => s.includes("const BASE"))!;
    const themes = /const THEMES = \[([^\]]*)\]/.exec(app)![1]!.split(",").map((s) => s.trim().replace(/"/g, ""));
    expect(themes).toEqual(["system", ...NAMED]);
    const scheme = [...(/const THEME_SCHEME = \{([^}]*)\}/.exec(app)![1]!).matchAll(/(\w+): "(dark|light)"/g)]
      .map((m) => m[1]!);
    expect(scheme.sort()).toEqual([...NAMED].sort());
    // The one storage key, spelt the same in both copies (PRD §3.7 prefix).
    expect(app).toContain('const THEME_KEY = "__tn_theme"');
  });
});

describe("themes: the switch", () => {
  const app = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]!)
    .find((s) => s.includes("const BASE"))!;
  const switcher = app.slice(app.indexOf("const ThemeSwitch"), app.indexOf("// An ISO instant"));

  test("it offers the five choices and says which is on", () => {
    expect(switcher).toContain("THEMES.map");
    expect(switcher).toContain("aria-pressed=${value === t}");
    expect(switcher).toContain('data-theme-name=${t}');
    expect(switcher).toContain('role="group"');
    expect(switcher).toContain('aria-label="Theme"');
    for (const name of ["system", ...NAMED]) expect(app).toContain(`${name}:`); // a title for each
  });

  test("it is keyboard operable: real buttons, plus ← → across the group", () => {
    expect(switcher).toContain("<button");
    expect(switcher).toContain('type="button"');
    expect(switcher).toContain("ArrowRight");
    expect(switcher).toContain("ArrowLeft");
    expect(switcher).toContain(".focus()");
  });

  test("it is mounted in the header, beside the other controls for THIS browser", () => {
    const header = app.slice(app.indexOf("<header"), app.indexOf("</header>"));
    expect(header).toContain("<${ThemeSwitch} value=${theme} onChange=${setTheme} />");
    expect(header.indexOf("<${ThemeSwitch}")).toBeLessThan(header.indexOf('href=${settingsOpen'));
  });

  test("the choice is persisted, and reading it back cannot throw", () => {
    expect(app).toContain("localStorage.setItem(THEME_KEY, theme)");
    const read = app.slice(app.indexOf("const readTheme"), app.indexOf("const readTheme") + 300);
    expect(read).toContain("try {");
    expect(read).toContain("catch {}");
    expect(read).toContain('return "system"');
    // While the choice is "system" the page keeps following the OS.
    expect(app).toContain('if (theme !== "system") return;');
    expect(app).toContain('addEventListener("change", onFlip)');
  });
});

/**
 * The screens in front of the app — lock, consent, ingress deny — are served by
 * src/screens.ts with their own stylesheet, and they were left out of the theme
 * contract when the app joined it. Two consequences, both real: the light
 * palette here kept the ember (#a2621d) the app had already moved off because
 * the submit button computes to 4.37:1 against it, and a person reading on
 * `paper` who pressed Lock landed on whatever the OS preferred.
 *
 * These screens must keep working with JavaScript off, so the @media block
 * stays as the fallback and the pre-paint script only overrides it for a stored
 * choice. That is what is pinned here.
 */
describe("themes: the screens in front of the app", () => {
  const shellHtml = loginPage({ instanceName: "x", base: "" });
  const shellStyle = /<style>([\s\S]*?)<\/style>/.exec(shellHtml)![1]!;
  const shellCss = shellStyle.replace(/\/\*[\s\S]*?\*\//g, "");
  /** The @media (prefers-color-scheme: light) fallback, on its own. */
  const mediaBlock = /@media \(prefers-color-scheme: light\) \{([\s\S]*?)\n  \}/.exec(shellCss)![1]!;
  const shellBlocks = themeBlocks(shellCss.replace(mediaBlock, ""));
  const mediaTokens = themeBlocks(mediaBlock).get("default")!;

  test("it carries the same four named blocks as the app, plus the JS-off default", () => {
    expect([...shellBlocks.keys()]).toEqual(["default", ...NAMED]);
    // …and keeps the media query the app dropped: with no script there is
    // nothing else to read the OS with, and no person to overrule.
    expect(shellCss).toContain("@media (prefers-color-scheme: light)");
  });

  test("every screen theme defines every token the screen default defines", () => {
    const expected = Object.keys(shellBlocks.get("default")!).sort();
    for (const name of [...NAMED]) {
      expect(`${name} ${Object.keys(shellBlocks.get(name)!).sort().join()}`).toBe(`${name} ${expected.join()}`);
    }
    expect(Object.keys(mediaTokens).sort()).toEqual(expected);
  });

  test("the values agree with the app's, token for token — one world, not two", () => {
    for (const name of NAMED) {
      for (const [token, value] of Object.entries(shellBlocks.get(name)!)) {
        if (token === "lamp") continue; // a different geometry, deliberately: these screens are centred
        expect(`${name} --${token}: ${value}`).toBe(`${name} --${token}: ${blocks.get(name)![token]}`);
      }
    }
    // The default is ember here too, and the media fallback is daylight.
    expect(shellBlocks.get("default")).toEqual(shellBlocks.get("ember")!);
    for (const token of ["ground", "panel", "line", "ink", "dim", "ember", "clay"]) {
      expect(`fallback --${token}: ${mediaTokens[token]}`).toBe(`fallback --${token}: ${blocks.get("daylight")![token]}`);
    }
  });

  test.each([...NAMED, "fallback"])("%s: text clears 4.5:1, and so does the submit button", (name) => {
    const tokens = name === "fallback" ? mediaTokens : shellBlocks.get(name)!;
    // What these screens paint: text on the body ground and on the form panel…
    for (const fg of ["ink", "dim", "ember", "clay"]) {
      for (const bg of ["ground", "panel"]) {
        const ratio = contrast(tokens[fg]!, tokens[bg]!);
        expect(`${name} ${fg}-on-${bg} ${ratio.toFixed(2)}`).toBe(
          `${name} ${fg}-on-${bg} ${Math.max(ratio, 4.5).toFixed(2)}`,
        );
      }
    }
    // …and one filled control, `background: var(--ember); color: var(--ground)`.
    // This is the pair the old light block failed at 4.37:1.
    const button = contrast(tokens["ground"]!, tokens["ember"]!);
    expect(`${name} button ${button.toFixed(2)}`).toBe(`${name} button ${Math.max(button, 4.5).toFixed(2)}`);
    expect(shellCss).toContain("background: var(--ember); color: var(--ground)");
  });

  test("the pre-paint runs before the stylesheet and reads the same key", () => {
    const prepaint = [...shellHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1]!)
      .find((s) => s.includes("__tn_theme"))!;
    expect(prepaint).toBeDefined();
    expect(shellHtml.indexOf(prepaint)).toBeLessThan(shellHtml.indexOf("<style>"));
    expect(shellHtml).toContain('<meta name="color-scheme"');
    expect(prepaint).toContain('localStorage.getItem("__tn_theme")');
    expect(prepaint).toContain("try {");
    // Same own-key check as the page's copy.
    expect(prepaint).toContain("Object.prototype.hasOwnProperty.call(SCHEME, stored)");
    // "system" is left to the media query here — the script must NOT set an
    // attribute for it, or a JS-on page would freeze on whatever the OS said
    // at load and stop following it.
    expect(prepaint).toContain('if (choice === "system") return;');
    // The third copy of the theme list; drift between the three is the bug.
    const names = [...prepaint.matchAll(/(\w+): "(dark|light)"/g)].map((m) => m[1]!);
    expect(names.sort()).toEqual([...NAMED].sort());
  });

  test("every screen gets the theme, not just the lock screen", () => {
    const deny = denyPage({ instanceName: "x", userId: "u", userName: "n", allowlistOption: "o" });
    for (const name of NAMED) expect(deny).toContain(`:root[data-theme="${name}"]`);
    expect(deny).toContain("__tn_theme");
  });
});

/**
 * The pre-paint scripts, RUN rather than read.
 *
 * The two copies ship as text, so the checks above can only assert about their
 * source. These execute the shipped text against a stub DOM — the one way to
 * prove what a browser will actually put on <html> before the first paint.
 *
 * The case that made this worth writing: `if (SCHEME[stored])` accepted any
 * key on Object.prototype, so `__tn_theme = "constructor"` painted an unstyled
 * data-theme and stamped `function Object() { [native code] }` into the meta.
 * The app's copy repairs it on hydration — but only if the CDN scripts arrive.
 */
describe("themes: the pre-paint, executed", () => {
  type Run = { theme: string | null; choice: string | null; scheme: string | null };

  /** Runs a pre-paint source with localStorage, matchMedia and document stubbed. */
  const run = (source: string, stored: string | null, osDark: boolean): Run => {
    const attrs: Record<string, string> = {};
    const meta = { content: "dark light", setAttribute: (k: string, v: string) => { if (k === "content") meta.content = v; } };
    const document = {
      documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } },
      querySelector: (sel: string) => (sel === 'meta[name="color-scheme"]' ? meta : null),
    };
    const localStorage = { getItem: (k: string) => (k === "__tn_theme" ? stored : null) };
    const matchMedia = (q: string) => ({ matches: q.includes("dark") ? osDark : !osDark });
    new Function("localStorage", "matchMedia", "document", source)(localStorage, matchMedia, document);
    return { theme: attrs["data-theme"] ?? null, choice: attrs["data-theme-choice"] ?? null, scheme: meta.content };
  };

  const pagePrepaint = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]!)
    .find((s) => s.includes("__tn_theme") && !s.includes("const BASE"))!;
  const screenPrepaint = [...loginPage({ instanceName: "x", base: "" })
    .matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]!)
    .find((s) => s.includes("__tn_theme"))!;

  test("the page paints the stored theme, and resolves `system` from the OS", () => {
    expect(run(pagePrepaint, "paper", false)).toEqual({ theme: "paper", choice: "paper", scheme: "light" });
    expect(run(pagePrepaint, "slate", true)).toEqual({ theme: "slate", choice: "slate", scheme: "dark" });
    expect(run(pagePrepaint, null, true)).toEqual({ theme: "ember", choice: "system", scheme: "dark" });
    expect(run(pagePrepaint, "system", false)).toEqual({ theme: "daylight", choice: "system", scheme: "light" });
  });

  test.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    "a stored %s is not a theme — it falls back, and the meta stays a color-scheme",
    (junk) => {
      const light = run(pagePrepaint, junk, false);
      expect(light).toEqual({ theme: "daylight", choice: "system", scheme: "light" });
      const dark = run(pagePrepaint, junk, true);
      expect(dark).toEqual({ theme: "ember", choice: "system", scheme: "dark" });
    },
  );

  test("the screens paint a stored theme and leave `system` to their media query", () => {
    expect(run(screenPrepaint, "paper", true)).toEqual({ theme: "paper", choice: "paper", scheme: "light" });
    // No attribute for system/junk/nothing: the @media block decides, which is
    // what keeps these screens correct with JavaScript off.
    expect(run(screenPrepaint, null, false)).toEqual({ theme: null, choice: null, scheme: "dark light" });
    expect(run(screenPrepaint, "system", false)).toEqual({ theme: null, choice: null, scheme: "dark light" });
    expect(run(screenPrepaint, "constructor", false)).toEqual({ theme: null, choice: null, scheme: "dark light" });
  });

  test("neither copy throws when storage is forbidden — a private window still paints", () => {
    const boom = { getItem: () => { throw new Error("SecurityError"); } };
    for (const source of [pagePrepaint, screenPrepaint]) {
      const attrs: Record<string, string> = {};
      const document = {
        documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } },
        querySelector: () => null,
      };
      expect(() =>
        new Function("localStorage", "matchMedia", "document", source)(boom, () => ({ matches: true }), document),
      ).not.toThrow();
    }
  });
});
