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
