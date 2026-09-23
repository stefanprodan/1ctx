// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The layout rules as a checker over a source root. structure.test.ts
// runs it over src/ and over each fixture under test/fixtures/structure/,
// which must be rejected for exactly the rule its name says. Every
// import, re-export and dynamic import is resolved with Bun's own
// resolver so index files and tsconfig paths behave as the bundler sees
// them; CSS is read declaration by declaration, not line by line.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";

// the layer order: a server area may import only areas above it
export const LAYERS = [
  "lib",
  "db",
  "limits",
  "secrets",
  "render",
  "users",
  "usage",
  "audit",
  "providers",
  "mcp",
  "skills",
  "projects",
  "access",
  "agents",
  "memory",
  "knowledge",
  "sessions",
  "tools",
  "runner",
  "automations",
  "overview",
  "provision",
  "service",
  "web",
] as const;

export const MAX_LINES = 500;

// production files allowed past MAX_LINES, with the reason
export const LINE_EXEMPTIONS: Record<string, string> = {};

// files allowed a colour literal, with the reason: neither can read a
// custom property
export const LITERAL_EXEMPTIONS: Record<string, string> = {
  "client/index.html": "the theme-color meta is read before any stylesheet",
  "client/favicon.svg": "a favicon is loaded on its own, without the page",
};

// hosts no test may name: the suite never reaches a network
export const FORBIDDEN_HOSTS = [
  "openrouter.ai",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "exa.ai",
  "firecrawl.dev",
  "tavily.com",
];

// the two files at the server root, the composition; anything else
// there would inherit their right to import every area
const SERVER_ROOT_FILES = new Set(["main.ts", "compose.ts"]);

// the extensions an import may name; a bare specifier is refused
const IMPORT_EXTENSIONS = /\.(?:ts|tsx|css|html|json|svg|woff2)$/;

// the two stylesheets with global reach, and where they live
const TOKENS = join("client", "style", "tokens.css");
const BASE = join("client", "style", "base.css");

// a colour by any syntax, or by name
const COLOUR_FUNCTION =
  /(?:^|[\s:,(])(?:#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\()/i;
const NAMED_COLOURS = new Set(
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(
    " ",
  ),
);

export type Violation = { file: string; rule: string; detail: string };

const transpiler = new Bun.Transpiler({ loader: "tsx" });

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const isSource = (path: string) =>
  /\.(ts|tsx)$/.test(path) && !path.endsWith(".d.ts");

// "shared", "client", "server/<area>", "server/main" for a src-relative path
export function areaOf(rel: string): string {
  const parts = rel.split(sep);
  if (parts[0] === "server") {
    return parts.length > 2 ? `server/${parts[1]}` : "server/main";
  }
  return parts[0];
}

const lineAt = (code: string, index: number) =>
  code.slice(0, index).split("\n").length;

type Import = { specifier: string; kind: string };

// scanImports gives the specifiers; a plain scan of `export ... from`
// covers the re-exports it does not list, and a dynamic import whose
// argument is not a string literal is a violation on its own
function importsOf(source: string): { imports: Import[]; computed: number[] } {
  const imports: Import[] = [];
  const computed: number[] = [];
  const seen = new Set<string>();
  for (const found of transpiler.scanImports(source)) {
    seen.add(found.path);
    imports.push({ specifier: found.path, kind: found.kind });
  }
  // the transpiler drops type-only imports and does not list re-exports;
  // a scan of every `from "..."`, side-effect import and literal dynamic
  // import catches them, since a type-only edge is an edge here. Comments
  // are blanked first so one between the clause and its `from` hides
  // nothing; line numbers survive the blanking.
  const code = withoutComments(source);
  const literal = /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;
  for (const m of code.matchAll(literal)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    imports.push({ specifier: m[1], kind: "scan" });
  }
  // whitespace includes newlines, so a call split across lines is seen;
  // a template is a literal only when nothing is interpolated
  for (const m of code.matchAll(/\bimport\s*\(\s*(?:([^"'`\s)])|`([^`]*)`)/g)) {
    if (m[1] !== undefined || m[2].includes("${")) {
      computed.push(lineAt(code, m.index));
    }
  }
  return { imports, computed };
}

// block comments and whole-line comments replaced by spaces, newlines
// kept; a `//` inside a string on a line of code is left alone
function withoutComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/[^\n]*/gm, (c) => " ".repeat(c.length));
}

const isExternal = (s: string) =>
  !s.startsWith(".") && !s.startsWith("/") && !s.startsWith("@/");

export function check(root: string): Violation[] {
  const out: Violation[] = [];
  const files = walk(root);
  const sources = files.filter(isSource);
  const edges = new Map<string, Set<string>>();

  for (const file of sources) {
    const rel = relative(root, file);
    const area = areaOf(rel);
    if (area === "server/main" && !SERVER_ROOT_FILES.has(basename(rel))) {
      out.push({
        file: rel,
        rule: "main",
        detail: "only main.ts and compose.ts live at the server root",
      });
    }
    const code = readFileSync(file, "utf8");
    const lineCount = code.split("\n").length;
    const isTest = rel.startsWith("test");
    if (!isTest && lineCount > MAX_LINES && !(rel in LINE_EXEMPTIONS)) {
      out.push({
        file: rel,
        rule: "size",
        detail: `${lineCount} lines, over ${MAX_LINES}`,
      });
    }
    const { imports, computed } = importsOf(code);
    for (const line of computed) {
      out.push({
        file: rel,
        rule: "dynamic",
        detail: `computed dynamic import on line ${line}`,
      });
    }
    if (
      area === "client" ||
      (rel.startsWith("server/tools/visual-") &&
        rel.endsWith(".ts") &&
        rel !== "server/tools/visual-theme.ts")
    ) {
      for (const line of colourLiterals(code)) {
        out.push({
          file: rel,
          rule: "tokens",
          detail: `colour literal on line ${line}; use a token`,
        });
      }
    }
    const targets = new Set<string>();
    for (const imp of imports) {
      const s = imp.specifier;
      if (isExternal(s)) {
        const builtin = s.startsWith("bun") || s.startsWith("node:");
        if (area === "shared") {
          out.push({ file: rel, rule: "shared", detail: `imports ${s}` });
        } else if (area === "client" && builtin) {
          out.push({ file: rel, rule: "client", detail: `imports ${s}` });
        }
        continue;
      }
      if (!IMPORT_EXTENSIONS.test(s)) {
        out.push({
          file: rel,
          rule: "extension",
          detail: `imports ${s} without its extension`,
        });
        continue;
      }
      let resolved: string;
      try {
        resolved = Bun.resolveSync(s, dirname(file));
      } catch {
        out.push({
          file: rel,
          rule: "unresolved",
          detail: `cannot resolve ${s}`,
        });
        continue;
      }
      const target = relative(root, resolved);
      if (extname(target) === ".json") continue;
      if (target.startsWith("..")) {
        out.push({
          file: rel,
          rule: "escape",
          detail: `imports ${s} outside the root`,
        });
        continue;
      }
      const ext = extname(target);
      if (ext === ".html") {
        if (rel !== join("server", "main.ts")) {
          out.push({
            file: rel,
            rule: "html",
            detail: `only server/main.ts imports the page`,
          });
        }
        continue;
      }
      if (ext === ".css") {
        if (area !== "client") {
          out.push({
            file: rel,
            rule: "css",
            detail: `only the client imports a stylesheet`,
          });
        }
        continue;
      }
      if (!isSource(target)) continue;
      targets.add(target);
      const targetArea = areaOf(target);
      if (targetArea === area) continue;
      const detail = `${area} imports ${target}`;
      if (area === "shared") {
        out.push({ file: rel, rule: "shared", detail });
      } else if (area === "client") {
        if (targetArea !== "shared")
          out.push({ file: rel, rule: "client", detail });
      } else if (targetArea === "client") {
        out.push({ file: rel, rule: "server", detail });
      } else if (targetArea === "shared" || area === "server/main") {
        // fine: everyone may import shared; main imports everything
      } else if (targetArea === "server/main") {
        out.push({ file: rel, rule: "main", detail });
      } else {
        const from = area.slice("server/".length);
        const to = targetArea.slice("server/".length);
        const fromIndex = LAYERS.indexOf(from as (typeof LAYERS)[number]);
        const toIndex = LAYERS.indexOf(to as (typeof LAYERS)[number]);
        if (fromIndex === -1) {
          out.push({
            file: rel,
            rule: "layer",
            detail: `${from} is not a listed area`,
          });
        } else if (toIndex === -1) {
          out.push({
            file: rel,
            rule: "layer",
            detail: `${to} is not a listed area`,
          });
        } else if (to === "web") {
          out.push({
            file: rel,
            rule: "layer",
            detail: `${detail}; nothing imports web`,
          });
        } else if (from === "web" && to !== "access" && to !== "lib") {
          out.push({
            file: rel,
            rule: "layer",
            detail: `${detail}; web imports only access and lib`,
          });
        } else if (toIndex >= fromIndex) {
          out.push({
            file: rel,
            rule: "layer",
            detail: `${detail}; ${to} is not above ${from}`,
          });
        } else if (
          to !== "lib" &&
          to !== "db" &&
          basename(target) !== "index.ts"
        ) {
          out.push({
            file: rel,
            rule: "facade",
            detail: `${detail}; use its index.ts`,
          });
        }
      }
    }
    edges.set(rel, targets);
  }

  // file cycles over the resolved graph, type-only edges included
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const cycles = new Set<string>();
  const visit = (file: string) => {
    const s = state.get(file);
    if (s === "done") return;
    if (s === "visiting") {
      const cycle = stack.slice(stack.indexOf(file)).concat(file);
      cycles.add(cycle.join(" -> "));
      return;
    }
    state.set(file, "visiting");
    stack.push(file);
    for (const next of edges.get(file) ?? []) visit(next);
    stack.pop();
    state.set(file, "done");
  };
  for (const file of edges.keys()) visit(file);
  for (const cycle of cycles) {
    out.push({ file: cycle.split(" -> ")[0], rule: "cycle", detail: cycle });
  }

  // markup carries no colour either, apart from the two files that
  // cannot read a token
  for (const file of files.filter((f) => /\.(html|svg)$/.test(f))) {
    const rel = relative(root, file);
    if (rel in LITERAL_EXEMPTIONS) continue;
    for (const line of colourLiterals(readFileSync(file, "utf8"))) {
      out.push({
        file: rel,
        rule: "tokens",
        detail: `colour literal on line ${line}; use a token`,
      });
    }
  }

  out.push(...cssCheck(root, files));
  return out;
}

// the CSS rules: every sheet opens with the layer order; tokens.css
// alone holds the literals; base.css alone reaches elements; every
// other sheet owns the prefix of its name and may style a base
// primitive only inside its own selector
function cssCheck(root: string, files: string[]): Violation[] {
  const out: Violation[] = [];
  const cssFiles = files.filter((f) => f.endsWith(".css"));
  const primitives = new Set<string>();
  const base = cssFiles.find((f) => relative(root, f) === BASE);
  if (base) {
    for (const selector of selectorsOf(readFileSync(base, "utf8"))) {
      for (const cls of selector.match(/\.[a-zA-Z0-9_-]+/g) ?? []) {
        primitives.add(cls.slice(1));
      }
    }
  }
  const names = new Map<string, string>();
  for (const file of cssFiles) {
    const rel = relative(root, file);
    const name = basename(file, ".css");
    const css = readFileSync(file, "utf8");
    const isTokens = rel === TOKENS;
    const isBase = rel === BASE;
    // the dev server injects each stylesheet on its own, leaf modules
    // first; the first layer statement seen fixes the order, so every
    // sheet carries it
    if (!/^(?:\s*\/\*[\s\S]*?\*\/)?\s*@layer tokens, base, owners;/.test(css)) {
      out.push({
        file: rel,
        rule: "layers",
        detail: "must open with @layer tokens, base, owners;",
      });
    }
    if (!isTokens) {
      for (const { property, value, line } of declarationsOf(css)) {
        const literal = tokenLiteral(property, value);
        if (literal) {
          out.push({
            file: rel,
            rule: "tokens",
            detail: `${literal} on line ${line}`,
          });
        }
      }
    }
    if (isTokens || isBase) continue;
    // the ownership prefix is the file name, so two sheets of one name
    // would own each other's classes
    if (name === "tokens" || name === "base") {
      out.push({
        file: rel,
        rule: "owner",
        detail: `only style/${name}.css may be named ${name}.css`,
      });
      continue;
    }
    const other = names.get(name);
    if (other) {
      out.push({
        file: rel,
        rule: "owner",
        detail: `${other} is already named ${name}.css`,
      });
      continue;
    }
    names.set(name, rel);
    for (const selector of selectorsOf(css)) {
      const global = globalCompound(selector);
      if (global) {
        out.push({
          file: rel,
          rule: "owner",
          detail: `"${global}" in "${selector}" is not a class`,
        });
        continue;
      }
      const classes = (selector.match(/\.[a-zA-Z0-9_-]+/g) ?? []).map((c) =>
        c.slice(1),
      );
      const owns = (c: string) => c === name || c.startsWith(`${name}-`);
      const inOwner = classes.some(owns);
      for (const c of classes) {
        if (owns(c)) continue;
        // a primitive inside the owner's own selector is composition
        if (inOwner && primitives.has(c)) continue;
        out.push({
          file: rel,
          rule: "owner",
          detail: `.${c} is not ${name}'s`,
        });
      }
    }
  }
  return out;
}

// the first compound of a selector that is not a class, a pseudo, or
// the nesting `&`: an element, an attribute, an id, or `*`; the
// selectors inside :is(), :where(), :has() and :not() are checked the
// same way
export function globalCompound(selector: string): string | null {
  const inner = /:(?:is|where|has|not)\(([^()]*)\)/g;
  for (const m of selector.matchAll(inner)) {
    for (const part of m[1].split(",")) {
      const found = globalCompound(part.trim().replace(/^[>+~]\s*/, ""));
      if (found !== null) return found;
    }
  }
  const outer = selector.replace(inner, "");
  for (const raw of outer.split(/\s*[>+~]\s*|\s+/)) {
    const compound = raw.replace(/^&/, "");
    if (compound === "") continue;
    if (compound.startsWith(".") || compound.startsWith(":")) continue;
    return compound;
  }
  return null;
}

// what a declaration outside tokens.css may not carry, or null
export function tokenLiteral(property: string, value: string): string | null {
  const words = value.toLowerCase().match(/[a-z]+/g) ?? [];
  if (COLOUR_FUNCTION.test(value) || words.some((w) => NAMED_COLOURS.has(w))) {
    return "colour literal";
  }
  // a fallback in var() is a literal by another route
  const bare = value.replace(/\s*!important$/i, "");
  const isVar = /^var\(--[a-z0-9-]+\)$/i.test(bare) || bare === "inherit";
  if (property === "font" && value !== "inherit") return "font shorthand";
  if (property === "font-family" && !isVar) return "font family";
  if (property === "font-size" && !isVar) return "font size";
  if (/radius$/.test(property) && !isVar && value !== "50%" && value !== "0") {
    return "radius";
  }
  return null;
}

// colour literals in code or markup, by line: hex of any length, a
// colour function, or a colour name where a value goes (after `:` or
// `=`, quoted or not), so prose may still say "red"
export function colourLiterals(text: string): number[] {
  const out: number[] = [];
  const hex = /(?:^|["'`\s(,=:])#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi;
  const fn =
    /(?:^|["'`\s(,=:])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/gi;
  const named = /[:=]\s*["']?([a-z]+)\b/gi;
  for (const m of text.matchAll(hex)) out.push(lineAt(text, m.index));
  for (const m of text.matchAll(fn)) out.push(lineAt(text, m.index));
  for (const m of text.matchAll(named)) {
    if (NAMED_COLOURS.has(m[1].toLowerCase())) out.push(lineAt(text, m.index));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// no test names a real provider host; the fixtures and this checker are
// the two places the list may appear
export function networkCheck(testDir: string): Violation[] {
  const out: Violation[] = [];
  for (const file of walk(testDir)) {
    const rel = relative(testDir, file);
    if (!isSource(file) || rel.startsWith("fixtures") || rel === "structure.ts")
      continue;
    const code = readFileSync(file, "utf8");
    for (const host of FORBIDDEN_HOSTS) {
      if (code.includes(host)) {
        out.push({ file: rel, rule: "network", detail: `names ${host}` });
      }
    }
  }
  return out;
}

type Declaration = { property: string; value: string; line: number };

// every `property: value` inside a block, at any nesting, whatever the
// line breaks; preludes (the text before `{`) are not declarations
export function declarationsOf(css: string): Declaration[] {
  const out: Declaration[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) =>
    c.replace(/[^\n]/g, " "),
  );
  let buffer = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      buffer = "";
      start = i + 1;
    } else if (ch === ";" || ch === "}") {
      const colon = buffer.indexOf(":");
      const trimmed = buffer.trim();
      if (colon !== -1 && trimmed !== "" && !trimmed.startsWith("@")) {
        const lead = buffer.length - buffer.trimStart().length;
        out.push({
          property: buffer.slice(0, colon).trim().toLowerCase(),
          value: buffer.slice(colon + 1).trim(),
          line: lineAt(text, start + lead),
        });
      }
      buffer = "";
      start = i + 1;
    } else {
      buffer += ch;
    }
  }
  return out;
}

// the selector text before each `{` at any nesting, split on commas,
// at-rules and their preludes skipped
export function selectorsOf(css: string): string[] {
  const out: string[] = [];
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let buffer = "";
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (ch === "{") {
      const prelude = buffer.trim();
      buffer = "";
      if (prelude.startsWith("@")) continue;
      for (const part of prelude.split(",")) {
        const s = part.trim();
        if (s) out.push(s);
      }
    } else if (ch === "}") {
      buffer = "";
    } else if (ch === ";") {
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  return out;
}
