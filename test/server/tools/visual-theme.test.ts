import { expect, test } from "bun:test";
import {
  VISUAL_THEME_CSS,
  visualThemeValues,
} from "../../../src/server/tools/visual-theme.ts";

test("defines every visual token and its short aliases", () => {
  for (const family of ["background", "text", "border"]) {
    for (const name of [
      "primary",
      "secondary",
      "tertiary",
      "info",
      "danger",
      "success",
      "warning",
    ]) {
      expect(VISUAL_THEME_CSS).toContain(`--color-${family}-${name}:`);
    }
  }
  for (const name of ["sans", "serif", "mono"]) {
    expect(VISUAL_THEME_CSS).toContain(`--font-${name}:`);
  }
  for (const name of ["md", "lg", "xl"]) {
    expect(VISUAL_THEME_CSS).toContain(`--border-radius-${name}:`);
  }
  for (const [alias, name] of Object.entries({
    p: "text-primary",
    s: "text-secondary",
    t: "text-tertiary",
    bg2: "background-secondary",
    b: "border-tertiary",
  })) {
    expect(VISUAL_THEME_CSS).toContain(`--${alias}: var(--color-${name});`);
  }
});

test("ramps and semantic colors use the document theme, never the OS", () => {
  const ramps = [
    "purple",
    "teal",
    "coral",
    "pink",
    "gray",
    "blue",
    "green",
    "amber",
    "red",
  ];
  for (const scheme of ["light", "dark"]) {
    for (const ramp of ramps) {
      expect(VISUAL_THEME_CSS).toContain(
        `:root[data-theme="${scheme}"] svg .c-${ramp} > rect`,
      );
    }
    const blocks = VISUAL_THEME_CSS.match(
      new RegExp(`:root\\[data-theme="${scheme}"\\] \\{[^}]*\\}`, "g"),
    )?.join("\n");
    for (const name of ["info", "danger", "success", "warning"]) {
      expect(blocks).toContain(`--color-background-${name}:`);
      expect(blocks).toContain(`--color-text-${name}:`);
      expect(blocks).toContain(`--color-border-${name}:`);
    }
  }
  expect(VISUAL_THEME_CSS).not.toContain("prefers-color-scheme");
  expect(VISUAL_THEME_CSS).toContain("prefers-reduced-motion");
  expect(VISUAL_THEME_CSS).toContain("fill: #EEEDFE; stroke: #534AB7");
  expect(VISUAL_THEME_CSS).toContain("fill: #3C3489; stroke: #AFA9EC");
  expect(VISUAL_THEME_CSS).toContain("--color-background-success: #173404");
});

test("provides SVG helpers and bare form controls on a transparent body", () => {
  for (const name of ["t", "ts", "th", "box", "node", "arr", "leader"]) {
    expect(VISUAL_THEME_CSS).toContain(`.${name}`);
  }
  for (const name of ["text", "number", "range", "checkbox", "radio"]) {
    expect(VISUAL_THEME_CSS).toContain(`input[type="${name}"]`);
  }
  for (const name of ["button", "select", "textarea", "a"]) {
    expect(VISUAL_THEME_CSS).toContain(`${name} {`);
  }
  expect(VISUAL_THEME_CSS).toContain("html, body { background: transparent; }");
  expect(VISUAL_THEME_CSS).toContain("font-size: 16px; line-height: 1.7;");
});

test("maps posted page values without accepting arbitrary properties", () => {
  const values = {
    "--fg": " primary ",
    "--dim": "secondary",
    "--faint": "tertiary",
    "--card": "card",
    "--inset": "inset",
    "--page": "page",
    "--line": "line",
    "--line-strong": "strong",
    "--sans": "sans",
    "--serif": "serif",
    "--mono": "mono",
    "--radius": "6px",
    "--radius-card": "10px",
    "--unknown": "ignored",
  };
  expect(visualThemeValues(values)).toEqual({
    "--color-text-primary": "primary",
    "--color-text-secondary": "secondary",
    "--color-text-tertiary": "tertiary",
    "--color-background-primary": "page",
    "--color-background-secondary": "card",
    "--color-background-tertiary": "inset",
    "--color-border-primary": "strong",
    "--color-border-secondary": "line",
    "--color-border-tertiary": "line",
    "--font-sans": "sans",
    "--font-serif": "serif",
    "--font-mono": "mono",
    "--border-radius-md": "6px",
    "--border-radius-lg": "10px",
    "--border-radius-xl": "10px",
  });
  expect(visualThemeValues({ "--serif": " " })).toEqual({});
  expect(values["--fg"]).toBe(" primary ");
});
