// Adapted from CopilotKit/OpenGenerativeUI, packages/design-system/src/index.ts
// at 457e60cdf7f63fb78004486e1dc7ba753194696d. MIT, Copyright (c) Atai Barkai.
// The complete notice is in THIRD_PARTY_LICENSES.md.

export function visualThemeValues(
  values: Record<string, string>,
): Record<string, string> {
  const mapping: Record<string, string> = {
    "--color-text-primary": "--fg",
    "--color-text-secondary": "--dim",
    "--color-text-tertiary": "--faint",
    "--color-background-primary": "--page",
    "--color-background-secondary": "--card",
    "--color-background-tertiary": "--inset",
    "--color-border-primary": "--line-strong",
    "--color-border-secondary": "--line",
    "--color-border-tertiary": "--line",
    "--font-sans": "--sans",
    "--font-serif": "--serif",
    "--font-mono": "--mono",
    "--border-radius-md": "--radius",
    "--border-radius-lg": "--radius-card",
    "--border-radius-xl": "--radius-card",
  };
  const result: Record<string, string> = {};
  for (const [name, source] of Object.entries(mapping)) {
    const value = values[source]?.trim();
    if (value) result[name] = value;
  }
  return result;
}

const ramps = {
  purple: ["#EEEDFE", "#534AB7", "#3C3489", "#3C3489", "#AFA9EC", "#CECBF6"],
  teal: ["#E1F5EE", "#0F6E56", "#085041", "#085041", "#5DCAA5", "#9FE1CB"],
  coral: ["#FAECE7", "#993C1D", "#712B13", "#712B13", "#F0997B", "#F5C4B3"],
  pink: ["#FBEAF0", "#993556", "#72243E", "#72243E", "#ED93B1", "#F4C0D1"],
  gray: ["#F1EFE8", "#5F5E5A", "#444441", "#444441", "#B4B2A9", "#D3D1C7"],
  blue: ["#E6F1FB", "#185FA5", "#0C447C", "#0C447C", "#85B7EB", "#B5D4F4"],
  green: ["#EAF3DE", "#3B6D11", "#27500A", "#27500A", "#97C459", "#C0DD97"],
  amber: ["#FAEEDA", "#854F0B", "#633806", "#633806", "#EF9F27", "#FAC775"],
  red: ["#FCEBEB", "#A32D2D", "#791F1F", "#791F1F", "#F09595", "#F7C1C1"],
};
const semantic = {
  info: ["#E6F1FB", "#185FA5", "#0C447C", "#85B7EB"],
  danger: ["#FCEBEB", "#A32D2D", "#501313", "#F09595"],
  success: ["#EAF3DE", "#3B6D11", "#173404", "#97C459"],
  warning: ["#FAEEDA", "#854F0B", "#412402", "#EF9F27"],
};

function palette(scheme: "light" | "dark"): string {
  const offset = scheme === "light" ? 0 : 2;
  const root = `:root[data-theme="${scheme}"]`;
  const colors = Object.entries(semantic).map(
    ([name, stops]) => `
  --color-background-${name}: ${stops[offset]};
  --color-text-${name}: ${stops[offset + 1]};
  --color-border-${name}: ${stops[offset + 1]};`,
  );
  const classes = Object.entries(ramps).map(([name, stops]) => {
    const [fill, border, text] = stops.slice(scheme === "light" ? 0 : 3);
    return `
${root} svg .c-${name} > rect,
${root} svg .c-${name} > circle,
${root} svg .c-${name} > ellipse,
${root} svg rect.c-${name},
${root} svg circle.c-${name},
${root} svg ellipse.c-${name} { fill: ${fill}; stroke: ${border}; }
${root} svg .c-${name} text.th,
${root} svg .c-${name} text.t { fill: ${text}; }
${root} svg .c-${name} text.ts { fill: ${border}; }`;
  });
  return `${root} { color-scheme: ${scheme}; ${colors.join("")}\n}
${classes.join("\n")}`;
}

export const VISUAL_THEME_CSS = `
:root {
  --color-background-primary: #ffffff;
  --color-background-secondary: #f7f6f3;
  --color-background-tertiary: #efeee9;
  --color-text-primary: #1a1a1a;
  --color-text-secondary: #73726c;
  --color-text-tertiary: #9c9a92;
  --color-border-primary: rgba(0, 0, 0, 0.4);
  --color-border-secondary: rgba(0, 0, 0, 0.3);
  --color-border-tertiary: rgba(0, 0, 0, 0.15);
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-serif: Georgia, "Times New Roman", serif;
  --font-mono: "SF Mono", "Fira Code", "Fira Mono", monospace;
  --border-radius-md: 8px;
  --border-radius-lg: 12px;
  --border-radius-xl: 16px;
  --p: var(--color-text-primary);
  --s: var(--color-text-secondary);
  --t: var(--color-text-tertiary);
  --bg2: var(--color-background-secondary);
  --b: var(--color-border-tertiary);
}
:root[data-theme="dark"] {
  --color-background-primary: #1a1a18;
  --color-background-secondary: #2c2c2a;
  --color-background-tertiary: #222220;
  --color-text-primary: #e8e6de;
  --color-text-secondary: #9c9a92;
  --color-text-tertiary: #73726c;
  --color-border-primary: rgba(255, 255, 255, 0.4);
  --color-border-secondary: rgba(255, 255, 255, 0.3);
  --color-border-tertiary: rgba(255, 255, 255, 0.15);
}
${palette("light")}
${palette("dark")}
svg text.t { font: 400 14px var(--font-sans); fill: var(--p); }
svg text.ts { font: 400 12px var(--font-sans); fill: var(--s); }
svg text.th { font: 500 14px var(--font-sans); fill: var(--p); }
svg .box > rect, svg .box > circle, svg .box > ellipse {
  fill: var(--bg2); stroke: var(--b);
}
svg .node { cursor: pointer; }
svg .node:hover { opacity: 0.8; }
svg .arr { stroke: var(--s); stroke-width: 1.5; fill: none; }
svg .leader {
  stroke: var(--t); stroke-width: 0.5; stroke-dasharray: 4 4; fill: none;
}
* { box-sizing: border-box; margin: 0; }
html, body { background: transparent; }
body {
  font-family: var(--font-sans); font-size: 16px; line-height: 1.7;
  color: var(--color-text-primary); -webkit-font-smoothing: antialiased;
}
#visual-root { display: flow-root; }
button {
  font-family: inherit; font-size: 14px; padding: 6px 16px;
  border: 0.5px solid var(--color-border-secondary);
  border-radius: var(--border-radius-md);
  background: transparent; color: var(--color-text-primary); cursor: pointer;
  transition: background 0.15s, transform 0.1s;
}
button:hover { background: var(--color-background-secondary); }
button:active { transform: scale(0.98); }
input:not([type]), input[type="text"], input[type="number"],
input[type="email"], input[type="search"], textarea, select {
  font-family: inherit; font-size: 14px; padding: 6px 12px; height: 36px;
  border: 0.5px solid var(--color-border-tertiary);
  border-radius: var(--border-radius-md);
  background: var(--color-background-primary); color: var(--color-text-primary);
  transition: border-color 0.15s;
}
input:hover, textarea:hover, select:hover {
  border-color: var(--color-border-secondary);
}
input:focus, textarea:focus, select:focus {
  outline: 0.5px solid var(--color-border-primary);
  border-color: var(--color-border-primary);
}
textarea { height: auto; min-height: 80px; resize: vertical; }
input::placeholder, textarea::placeholder { color: var(--color-text-tertiary); }
input[type="range"] {
  appearance: none; height: 4px; border: none; border-radius: 2px;
  background: var(--color-border-tertiary);
}
input[type="range"]::-webkit-slider-thumb {
  appearance: none; width: 18px; height: 18px; border-radius: 50%;
  background: var(--color-background-primary);
  border: 0.5px solid var(--color-border-secondary); cursor: pointer;
}
input[type="range"]::-moz-range-thumb {
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--color-background-primary);
  border: 0.5px solid var(--color-border-secondary); cursor: pointer;
}
input[type="checkbox"], input[type="radio"] {
  width: 16px; height: 16px; accent-color: var(--color-text-info);
}
a { color: var(--color-text-info); text-decoration: none; }
a:hover { text-decoration: underline; }
.visual-enter { animation: visual-enter 0.3s ease-out both; }
@keyframes visual-enter {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`;
