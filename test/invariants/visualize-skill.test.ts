// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CATALOG_CAP,
  loadSkill,
  MAX_ALLOWED_TOOLS,
  MAX_ARCHIVE_MEMBERS,
  MAX_BODY_CHARS,
  MAX_DOWNLOAD_BYTES,
  MAX_FILE_CHARS,
  MAX_FILES,
  MAX_FILES_CHARS,
  MAX_LICENSE,
  MAX_METADATA_KEY,
  MAX_METADATA_KEYS,
  MAX_METADATA_VALUE,
  MAX_TAR_BYTES,
  parseSkillMd,
} from "../../src/server/skills/index.ts";
import { VISUAL_THEME_CSS } from "../../src/server/tools/visual-theme.ts";
import { DEFAULT_VISUAL_HOSTS } from "../../src/shared/contracts/tool.ts";
import {
  catalog,
  MAX_SKILL_RESOURCES,
  skillContent,
} from "../../src/shared/skills.ts";
import {
  MAX_SKILL_COMPATIBILITY,
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_NAME,
} from "../../src/shared/words.ts";

const root = join(import.meta.dir, "../..");
const revision = "457e60cdf7f63fb78004486e1dc7ba753194696d";
const references = [
  "references/art.md",
  "references/charts.md",
  "references/interactive.md",
  "references/libraries.md",
  "references/svg-diagrams.md",
  "references/ui-mockups.md",
];
const keptPaths = ["LICENSE", ...references];
const forbidden =
  /generateSandboxedUi|Websandbox|sendPrompt|jsFunctions|jsExpressions|importmap|plan_visualization|prefers-color-scheme/i;
const libraryFiles = new Set([
  "references/charts.md",
  "references/libraries.md",
]);
const hosts = new Set<string>(DEFAULT_VISUAL_HOSTS);
const chars = (text: string) => [...text].length;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const words = (text: string) => text.replace(/\s+/g, " ").trim();

function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(reason);
}

function sourceFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const base = join(root, "skills/visualize");
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      check(!entry.isSymbolicLink(), `skill symlink: ${path}`);
      if (entry.isDirectory()) visit(join(directory, entry.name), `${path}/`);
      else {
        check(entry.isFile(), `not a regular skill file: ${path}`);
        const buffer = readFileSync(join(directory, entry.name));
        files.set(
          path,
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            buffer,
          ),
        );
      }
    }
  };
  visit(base);
  return files;
}

function externalUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`)\]}]+/gi)].map(([url]) =>
    url.replace(/[.,;]+$/, ""),
  );
}

function checkUrls(text: string, path: string) {
  for (const address of externalUrls(text)) {
    check(
      libraryFiles.has(path),
      `external URL outside libraries/charts: ${path}`,
    );
    const url = new URL(address);
    check(
      url.protocol === "https:" &&
        hosts.has(url.origin) &&
        url.username === "" &&
        url.password === "",
      `external URL is not on a default host: ${address}`,
    );
  }
}

type Example = { html: string; section: string; label: string };

function examples(text: string, path: string): Example[] {
  const lines = text.split("\n");
  const result: Example[] = [];
  let section = 0;
  for (let line = 0; line < lines.length; line++) {
    if (/^## /.test(lines[line])) section = line;
    if (!/^```/.test(lines[line])) continue;
    const language = lines[line].slice(3).trim();
    const start = ++line;
    while (line < lines.length && !/^```\s*$/.test(lines[line])) line++;
    check(line < lines.length, `${path}:${start}: unclosed fence`);
    check(language === "html", `${path}:${start}: example must be HTML`);
    const nextSection = lines.findIndex(
      (value, index) => index > line && /^## /.test(value),
    );
    result.push({
      html: lines.slice(start, line).join("\n"),
      section: lines
        .slice(section, nextSection < 0 ? undefined : nextSection)
        .join("\n"),
      label: `${path}:${start + 1}`,
    });
  }
  return result;
}

const voidTags = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(
    " ",
  ),
);
const removedTags = new Set(
  "html head body meta base iframe frame object embed portal form".split(" "),
);
type HtmlNode = {
  tag: string;
  parent: number | null;
  svg: boolean;
  attrs: Map<string, string>;
  raw: string;
};

const paragraphClosers = new Set(
  "address article aside blockquote details div dl fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre search section table ul".split(
    " ",
  ),
);
const children: Record<string, string[]> = {
  table: ["caption", "colgroup", "thead", "tbody", "tfoot"],
  colgroup: ["col"],
  thead: ["tr"],
  tbody: ["tr"],
  tfoot: ["tr"],
  tr: ["th", "td"],
  ul: ["li"],
  ol: ["li"],
  select: ["option", "optgroup", "hr"],
  optgroup: ["option"],
};

function checkNesting(tag: string, ancestors: HtmlNode[]) {
  const parent = ancestors.at(-1);
  if (parent && !parent.svg && children[parent.tag]) {
    check(
      children[parent.tag].includes(tag),
      `invalid HTML nesting: ${parent.tag}/${tag}`,
    );
  }
  for (const ancestor of ancestors) {
    check(
      !(ancestor.tag === "p" && paragraphClosers.has(tag)) &&
        !((tag === "a" || tag === "button") && ancestor.tag === tag) &&
        !(/^h[1-6]$/.test(tag) && /^h[1-6]$/.test(ancestor.tag)),
      `invalid HTML nesting: ${ancestor.tag}/${tag}`,
    );
  }
  const scope: Record<string, string> = {
    li: "ul|ol",
    dt: "dl",
    dd: "dl",
    option: "select|optgroup",
    optgroup: "select",
  };
  if (scope[tag]) {
    for (const ancestor of ancestors.toReversed()) {
      if (scope[tag].split("|").includes(ancestor.tag)) break;
      check(
        ancestor.tag !== tag &&
          !(["dt", "dd"].includes(tag) && ["dt", "dd"].includes(ancestor.tag)),
        `invalid HTML nesting: ${ancestor.tag}/${tag}`,
      );
    }
  }
}

// HTMLRewriter is streaming, not a DOM parser: it can preserve invalid
// nesting. Require balanced tags and explicit table/list sections as well.
function scanHtml(html: string) {
  const nodes: HtmlNode[] = [];
  const stack: number[] = [];
  const marked: string[] = [];
  const visible: string[] = [];
  let phase = 0;
  let content = false;
  let offset = 0;
  while (offset < html.length) {
    if (html[offset] !== "<") {
      const next = html.indexOf("<", offset);
      const text = html.slice(offset, next < 0 ? undefined : next);
      check(stack.length > 0 || text.trim() === "", "text outside an element");
      check(
        !/&(?:#x[\da-f]*|#\d*|[a-z][\w]*)$/i.test(text),
        "partial HTML entity",
      );
      const parent = nodes[stack.at(-1)!];
      check(
        !parent || !children[parent.tag] || !text.trim(),
        "text in a structural HTML element",
      );
      if (text.trim()) visible.push(text);
      marked.push(text);
      offset += text.length;
      continue;
    }
    if (html.startsWith("<!--", offset)) {
      const end = html.indexOf("-->", offset + 4);
      check(end >= 0, "unclosed HTML comment");
      marked.push(html.slice(offset, end + 3));
      offset = end + 3;
      continue;
    }
    let end = offset + 1;
    let quote = "";
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    check(end < html.length && !quote, "partial HTML tag or attribute");
    const token = html.slice(offset, end + 1);
    offset = end + 1;
    const closing = /^<\/([a-z][\w:-]*)\s*>$/i.exec(token);
    if (closing) {
      const parent = stack.pop();
      check(
        parent !== undefined && nodes[parent].tag === closing[1].toLowerCase(),
        `unbalanced closing tag: ${token}`,
      );
      marked.push(token);
      continue;
    }
    const opening = /^<([a-z][\w:-]*)([\s\S]*?)>$/i.exec(token);
    check(opening, `invalid HTML tag: ${token}`);
    const tag = opening[1].toLowerCase();
    check(!removedTags.has(tag), `not a visual fragment element: ${tag}`);
    const selfClosing = /\/\s*$/.test(opening[2]);
    const tail = opening[2].replace(/\/\s*$/, "");
    const attrs = new Map<string, string>();
    const attribute =
      /\s+([^\s=/<>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/y;
    let at = 0;
    while (tail.slice(at).trim()) {
      attribute.lastIndex = at;
      const match = attribute.exec(tail);
      check(match, `invalid attribute in ${token}`);
      const name = match[1].toLowerCase();
      check(!attrs.has(name), `duplicate attribute: ${name}`);
      check(!name.startsWith("data-skill-"), "reserved validator attribute");
      attrs.set(name, match[2] ?? match[3] ?? match[4] ?? "");
      at = attribute.lastIndex;
    }
    const parent = stack.at(-1) ?? null;
    const svg = tag === "svg" || (parent !== null && nodes[parent].svg);
    checkNesting(
      tag,
      stack.map((index) => nodes[index]),
    );
    check(!selfClosing || svg || voidTags.has(tag), `self-closing HTML ${tag}`);
    if (tag === "style") {
      check(parent === null && phase === 0, "style must come first");
    } else if (tag === "script") {
      check(
        parent === null && content,
        "scripts must follow content at the end",
      );
      phase = 2;
    } else if (parent === null) {
      check(
        nodes.length > 0 && nodes[0].tag === "style",
        "style must come first",
      );
      check(phase !== 2, "content after a script");
      phase = 1;
      content = true;
    }
    const index = nodes.length;
    nodes.push({ tag, parent, svg, attrs, raw: "" });
    marked.push(token.replace(/^<[^\s/>]+/, `$& data-skill-node="${index}"`));
    if (tag === "style" || tag === "script") {
      const close = new RegExp(`</${tag}\\s*>`, "gi");
      close.lastIndex = offset;
      const match = close.exec(html);
      check(match, `unclosed ${tag}`);
      nodes[index].raw = html.slice(offset, match.index);
      marked.push(html.slice(offset, close.lastIndex));
      offset = close.lastIndex;
    } else if (!selfClosing && !voidTags.has(tag)) stack.push(index);
  }
  check(stack.length === 0, "unclosed HTML element");
  check(content, "fragment has no content");
  return { nodes, marked: marked.join(""), visible };
}

function cssNames(css: string) {
  const clean = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  const variables = new Set(
    [...clean.matchAll(/(?:^|[;{])\s*(--[\w-]+)\s*:/g)].map(
      (match) => match[1],
    ),
  );
  const classes = new Set<string>();
  for (const rule of clean.matchAll(/([^{}]+)\{/g)) {
    for (const match of rule[1].matchAll(/\.(-?[_a-z][\w-]*)/gi)) {
      classes.add(match[1]);
    }
  }
  return { variables, classes };
}

const theme = cssNames(VISUAL_THEME_CSS);

function attributeValue(value: string) {
  return value
    .replace(
      /&(?:#x([0-9a-f]+)|#([0-9]+)|(colon|tab|newline));?/gi,
      (_, hex: string, decimal: string, named: string) =>
        hex || decimal
          ? String.fromCodePoint(Number.parseInt(hex || decimal, hex ? 16 : 10))
          : ({ colon: ":", tab: "\t", newline: "\n" }[named.toLowerCase()] ??
            ""),
    )
    .replace(/\s/g, "");
}

async function checkExample(example: Example, path: string) {
  const { html, section, label } = example;
  checkUrls(html, path);
  const { nodes, marked, visible } = scanHtml(html);
  const local = cssNames(
    nodes
      .flatMap((node) => [
        node.tag === "style" ? node.raw : "",
        node.attrs.has("style") ? `* { ${node.attrs.get("style")} }` : "",
      ])
      .join("\n"),
  );
  for (const match of html.matchAll(/var\(\s*(--[\w-]+)/g)) {
    check(
      local.variables.has(match[1]) || theme.variables.has(match[1]),
      `${label}: undeclared CSS variable ${match[1]}`,
    );
  }
  const parents = new Set<number>();
  let elements = 0;
  const rewriter = new HTMLRewriter().on("[data-skill-node]", {
    element(element) {
      const index = Number(element.getAttribute("data-skill-node"));
      const node = nodes[index];
      check(
        node && node.tag === element.tagName.toLowerCase(),
        "HTML parse changed a tag",
      );
      elements++;
      for (const [name, value] of element.attributes) {
        check(!/^on/i.test(name), `${label}: event attribute ${name}`);
        const normalized = attributeValue(value);
        check(!/^javascript:/i.test(normalized), `${label}: javascript URL`);
        check(!/^\/\//.test(normalized), `${label}: protocol-relative URL`);
        if (node.svg && name === "class") {
          for (const className of value.split(/\s+/).filter(Boolean)) {
            check(
              local.classes.has(className) || theme.classes.has(className),
              `${label}: undeclared SVG class ${className}`,
            );
          }
        }
      }
    },
  });
  for (const [index, node] of nodes.entries()) {
    const parent =
      node.parent === null
        ? "[data-skill-root]"
        : `[data-skill-node="${node.parent}"]`;
    rewriter.on(`${parent} > [data-skill-node="${index}"]`, {
      element() {
        parents.add(index);
      },
    });
    if (node.tag === "script" && node.raw.trim()) {
      new Bun.Transpiler({ loader: "js" }).transformSync(node.raw);
    }
  }
  await rewriter
    .transform(new Response(`<div data-skill-root>${marked}</div>`))
    .text();
  check(elements === nodes.length, `${label}: HTML parser dropped an element`);
  check(
    parents.size === nodes.length,
    `${label}: HTML parser repaired nesting`,
  );
  if (externalUrls(html).length > 0) {
    const prose = section.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
    check(
      /^Without libraries:\s*\S[^\n]+/m.test(prose),
      `${label}: missing Without libraries explanation in its section`,
    );
    const inlineSvg = nodes.some(
      (node) =>
        node.svg &&
        [
          "path",
          "rect",
          "circle",
          "ellipse",
          "line",
          "polyline",
          "polygon",
        ].includes(node.tag),
    );
    check(
      visible.some((text) => text.trim().length > 0) || inlineSvg,
      `${label}: external example has no inline content`,
    );
  }
}

const mitNotice = `Copyright (c) Atai Barkai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`;

describe("visualize skill", () => {
  test("loads the entire directory unchanged within all ingest and catalog caps", async () => {
    const files = sourceFiles();
    expect([...files.keys()].sort()).toEqual(["SKILL.md", ...keptPaths].sort());
    const archive = await new Bun.Archive(
      Object.fromEntries<string>(
        [...files].map(([path, text]) => [`visualize/${path}`, text] as const),
      ),
      { compress: "gzip" },
    ).bytes();
    expect(archive.byteLength).toBeLessThanOrEqual(MAX_DOWNLOAD_BYTES);
    expect(Bun.gunzipSync(archive).byteLength).toBeLessThanOrEqual(
      MAX_TAR_BYTES,
    );
    const members = await new Bun.Archive(archive).files();
    expect(members.size).toBe(files.size);
    expect(members.size).toBeLessThanOrEqual(MAX_ARCHIVE_MEMBERS);
    const url = "https://skills.test/visualize.tar.gz";
    const requests: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const address = input instanceof Request ? input.url : String(input);
      requests.push(address);
      check(address === url, `unexpected skill request: ${address}`);
      return new Response(archive.slice(), {
        headers: { "Content-Type": "application/gzip" },
      });
    }) as typeof fetch;
    const loaded = await loadSkill(
      fetcher,
      url,
      { path: "visualize" },
      new AbortController().signal,
    );
    expect(requests).toEqual([url]);
    expect(loaded.sourceKind).toBe("archive");
    expect(loaded.sourceUrl).toBe(url);
    expect(loaded.sourceSelect).toBe("visualize");
    expect(loaded.dropped).toEqual([]);
    expect(loaded.droppedMore).toBe(0);
    expect(loaded.files.map((file) => file.path).sort()).toEqual(keptPaths);
    expect(loaded.files.length).toBeLessThanOrEqual(MAX_FILES);
    let total = 0;
    for (const file of loaded.files) {
      expect(file.content).toBe(files.get(file.path)!);
      expect(file.bytes).toBe(bytes(file.content));
      expect(chars(file.content)).toBeLessThanOrEqual(MAX_FILE_CHARS);
      total += chars(file.content);
    }
    expect(total).toBeLessThanOrEqual(MAX_FILES_CHARS);
    const source = files.get("SKILL.md")!;
    const header = /^---\n([\s\S]*?)\n---\n/.exec(source);
    check(header, "SKILL.md needs closed frontmatter");
    const raw = Bun.YAML.parse(header[1]) as Record<string, unknown>;
    const parsed = parseSkillMd(source);
    expect(loaded.name).toBe("visualize");
    expect(loaded.name.length).toBeLessThanOrEqual(MAX_SKILL_NAME);
    expect(loaded.body).toBe(source.slice(header[0].length).replace(/^\n/, ""));
    expect(chars(loaded.body)).toBeLessThanOrEqual(MAX_BODY_CHARS);
    for (const [key, field, cap] of [
      ["name", "name", MAX_SKILL_NAME],
      ["description", "description", MAX_SKILL_DESCRIPTION],
      ["license", "license", MAX_LICENSE],
      ["compatibility", "compatibility", MAX_SKILL_COMPATIBILITY],
      ["allowed-tools", "allowedTools", MAX_ALLOWED_TOOLS],
    ] as const) {
      const value = raw[key] ?? "";
      check(typeof value === "string", `${key} must be text`);
      expect(chars(value)).toBeLessThanOrEqual(cap);
      expect(parsed[field]).toBe(
        key === "description" ? words(value) : value.trim(),
      );
      expect(loaded[field]).toBe(parsed[field]);
    }
    expect(loaded.license).toMatch(/^MIT\b/);
    const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
    const expectedMetadata: Record<string, string> = {};
    expect(Object.keys(metadata).length).toBeLessThanOrEqual(MAX_METADATA_KEYS);
    for (const [key, value] of Object.entries(metadata)) {
      check(typeof value === "string", `metadata ${key} must be text`);
      expect(chars(key)).toBeLessThanOrEqual(MAX_METADATA_KEY);
      expect(chars(value)).toBeLessThanOrEqual(MAX_METADATA_VALUE);
      expectedMetadata[key] = value;
    }
    expect(loaded.metadata).toEqual(expectedMetadata);
    const named = [
      ...loaded.body.matchAll(/\breferences\/[a-z0-9._/-]+/gi),
    ].map((match) => match[0].replace(/[.,]+$/, ""));
    expect([...new Set(named)].sort()).toEqual(references);
    const offered = catalog([loaded], CATALOG_CAP);
    expect(offered.included).toEqual([loaded]);
    expect(offered.leftOut).toEqual([]);
    expect(offered.text.length).toBeLessThanOrEqual(CATALOG_CAP);
    expect(offered.text).toContain("<name>visualize</name>");
    expect(keptPaths.length).toBeLessThanOrEqual(MAX_SKILL_RESOURCES);
    const content = skillContent({ ...loaded, files: keptPaths });
    for (const path of keptPaths)
      expect(content).toContain(`<file>${path}</file>`);
    const prerequisite = words(
      loaded.body
        .replace(/^#+[^\n]*$/gm, "")
        .trim()
        .split(/\n\s*\n/)[0],
    );
    expect(prerequisite).toMatch(/\bonly\b.*\bvisualize\b.*\boffered\b/i);
    expect(prerequisite).toMatch(
      /\b(?:otherwise|else|not|unavailable)\b.*\btext\b/i,
    );
  });

  test("keeps the complete upstream license and the theme's pinned revision", () => {
    const license = sourceFiles().get("LICENSE")!;
    const notices = readFileSync(join(root, "THIRD_PARTY_LICENSES.md"), "utf8");
    const upstream = notices
      .split("## OpenGenerativeUI\n")[1]
      ?.split("\n## ")[0];
    check(upstream, "missing OpenGenerativeUI notice");
    for (const text of [license, upstream]) {
      expect(words(text)).toContain(words(mitNotice));
      expect(text).toContain("MIT License");
      expect(text).toContain("CopilotKit/OpenGenerativeUI");
      expect([...new Set(text.match(/\b[0-9a-f]{40}\b/g))]).toEqual([revision]);
    }
    expect(upstream).toContain("skills/visualize");
    expect(upstream).toContain("src/server/tools/visual-theme.ts");
    const themeSource = readFileSync(
      join(root, "src/server/tools/visual-theme.ts"),
      "utf8",
    );
    expect(themeSource).toContain("CopilotKit/OpenGenerativeUI");
    expect(themeSource).toContain("Copyright (c) Atai Barkai");
    expect([...new Set(themeSource.match(/\b[0-9a-f]{40}\b/g))]).toEqual([
      revision,
    ]);
  });

  test("stages, archives and verifies the notice beside the release binary", () => {
    const workflow = Bun.YAML.parse(
      readFileSync(join(root, ".github/workflows/release.yml"), "utf8"),
    ) as {
      jobs: { release: { steps: { name: string; run?: string }[] } };
    };
    const steps = workflow.jobs.release.steps.filter(
      (step) => step.name === "Build release archive",
    );
    expect(steps).toHaveLength(1);
    check(steps[0].run, "release archive step has no commands");
    const commands = steps[0].run
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/));
    expect(commands).toContainEqual(["set", "-euo", "pipefail"]);
    const copy = commands.find((command) => command[0] === "cp");
    const archive = commands.find(
      (command) => command[0] === "tar" && command.includes("-czf"),
    );
    const listing = commands.find(
      (command) => command[0] === "tar" && command.includes("-tzf"),
    );
    check(copy && archive && listing, "missing release packaging command");
    const notice = "THIRD_PARTY_LICENSES.md";
    expect(copy.slice(1, -1).sort()).toEqual(
      ["bin/1ctx", "LICENSE", notice].sort(),
    );
    const directory = (value: string) =>
      value.replace(/^["']|["']$/g, "").replace(/\/$/, "");
    check(archive.includes("-C"), "release archive has no staging directory");
    expect(directory(archive[archive.indexOf("-C") + 1])).toBe(
      directory(copy.at(-1)!),
    );
    const output = archive.indexOf("-czf") + 1;
    expect(archive.slice(output + 1)).toEqual(["1ctx", "LICENSE", notice]);
    expect(listing[listing.indexOf("-tzf") + 1]).toBe(archive[output]);
    check(listing.includes("|"), "release archive listing is not checked");
    expect(listing.slice(listing.indexOf("|") + 1)).toEqual([
      "grep",
      "-Fx",
      notice,
    ]);
    expect(commands.indexOf(copy)).toBeLessThan(commands.indexOf(archive));
    expect(commands.indexOf(archive)).toBeLessThan(commands.indexOf(listing));
  });

  test("keeps every example complete, inline-capable and within the frame vocabulary", async () => {
    for (const [path, text] of sourceFiles()) {
      expect(text, path).not.toMatch(forbidden);
      checkUrls(text, path);
      const prose = text.replace(/^```html\n[\s\S]*?^```\s*$/gm, "");
      for (const match of prose.matchAll(/var\(\s*(--[\w-]+)/g)) {
        expect(theme.variables.has(match[1]), `${path}: ${match[1]}`).toBe(
          true,
        );
      }
      const fragments = examples(text, path);
      if (references.includes(path))
        expect(fragments.length, path).toBeGreaterThan(0);
      for (const fragment of fragments) await checkExample(fragment, path);
    }
  });
});

const fragment = (html: string, section = ""): Example => ({
  html,
  section,
  label: "inline fixture",
});

describe("visualize example validation", () => {
  test("accepts nested SVG, local names, bare controls and a closing script", async () => {
    await checkExample(
      fragment(`
<style>.local { --accent: var(--color-text-info); fill: var(--accent); }</style>
<div><svg viewBox="0 0 680 100"><g class="c-blue">
<rect class="local" width="80" height="40"></rect><text class="t">A</text>
</g></svg><input type="range" min="0" max="10"></div>
<script>document.querySelector("input").addEventListener("input", () => {});</script>
`),
      "references/svg-diagrams.md",
    );
  });

  test.each([
    ["missing style", "<div>Content</div>", "style must come first"],
    [
      "late style",
      "<style></style><div>A<style></style></div>",
      "style must come first",
    ],
    [
      "early script",
      "<style></style><script>1;</script><div>A</div>",
      "scripts must follow",
    ],
    [
      "nested script",
      "<style></style><div><script>1;</script></div>",
      "scripts must follow",
    ],
    [
      "content after script",
      "<style></style><div>A</div><script>1;</script><div>B</div>",
      "content after a script",
    ],
    [
      "missing closing tag",
      "<style></style><div><span>A</span>",
      "unclosed HTML",
    ],
    [
      "misnested tags",
      "<style></style><div><span>A</div></span>",
      "unbalanced closing",
    ],
    [
      "browser-repaired nesting",
      "<style></style><p><div>A</div></p>",
      "invalid HTML nesting",
    ],
    [
      "missing table section",
      "<style></style><table><tr><td>A</td></tr></table>",
      "invalid HTML nesting",
    ],
    [
      "nested links",
      '<style></style><a href="#a"><a href="#b">A</a></a>',
      "invalid HTML nesting",
    ],
    ["partial tag", '<style></style><div title="unfinished', "partial HTML"],
    [
      "partial entity",
      "<style></style><div>A &am</div>",
      "partial HTML entity",
    ],
    ["partial style", "<style>.a {", "unclosed style"],
    ["self-closing div", "<style></style><div/>", "self-closing HTML"],
    [
      "duplicate attributes",
      '<style></style><div id="a" id="b">A</div>',
      "duplicate attribute",
    ],
    [
      "broken script",
      "<style></style><div>A</div><script>const value = ;</script>",
      "",
    ],
    [
      "nested handler",
      '<style></style><div><span><img onerror="bad()"></span></div>',
      "event attribute",
    ],
    [
      "SVG handler",
      '<style></style><svg><g><animate onbegin="bad()"></animate></g></svg>',
      "event attribute",
    ],
    [
      "mixed-case handler",
      '<style></style><svg><g oNcLiCk="bad()"></g></svg>',
      "event attribute",
    ],
    [
      "script URL",
      '<style></style><div><a href="javascript:bad()">A</a></div>',
      "javascript URL",
    ],
    [
      "SVG script URL",
      '<style></style><svg><a xlink:href="jav&#x61;script:bad()"><text>A</text></a></svg>',
      "javascript URL",
    ],
    [
      "whitespace script URL",
      '<style></style><a href="java&#10;script:bad()">A</a>',
      "javascript URL",
    ],
    [
      "relative host",
      '<style></style><div>A</div><script src="//cdn.jsdelivr.net/a.js"></script>',
      "protocol-relative URL",
    ],
    [
      "missing token",
      "<style>div{color:var(--not-a-theme-token)}</style><div>A</div>",
      "undeclared CSS variable",
    ],
    [
      "missing inline token",
      '<style></style><svg><rect style="fill:var(--missing)"></rect></svg>',
      "undeclared CSS variable",
    ],
    [
      "missing SVG class",
      '<style></style><svg><g><text class="not-a-theme-class">A</text></g></svg>',
      "undeclared SVG class",
    ],
    [
      "class mentioned in a comment",
      '<style>/* .missing {} */</style><svg class="missing"></svg>',
      "undeclared SVG class",
    ],
    [
      "class mentioned in a string",
      '<style>p { content: ".missing {"; }</style><svg class="missing"></svg>',
      "undeclared SVG class",
    ],
    [
      "variable mentioned in a comment",
      "<style>/* --missing: red; */div{color:var(--missing)}</style><div>A</div>",
      "undeclared CSS variable",
    ],
  ])("rejects %s", async (_, html, reason) => {
    await expect(
      checkExample(fragment(html), "references/art.md"),
    ).rejects.toThrow(reason);
  });

  test("does not borrow local variables or classes from another example", async () => {
    const text = `## First
\`\`\`html
<style>.local { --local: var(--p); }</style><svg class="local"></svg>
\`\`\`
## Second
\`\`\`html
<style>svg {fill: var(--local);}</style><svg class="local"></svg>
\`\`\``;
    const [first, second] = examples(text, "references/art.md");
    await checkExample(first, "references/art.md");
    await expect(checkExample(second, "references/art.md")).rejects.toThrow(
      "undeclared CSS variable",
    );
  });

  test("checks every URL and requires a fallback in the external example's own section", async () => {
    const html =
      '<style></style><p>Inline data</p><script src="https://cdn.jsdelivr.net/library.js"></script>';
    await checkExample(
      fragment(html, "Without libraries: the inline data remains."),
      "references/libraries.md",
    );
    await expect(
      checkExample(fragment(html), "references/libraries.md"),
    ).rejects.toThrow("Without libraries");
    await expect(
      checkExample(
        fragment(html, "Without libraries: data remains."),
        "references/art.md",
      ),
    ).rejects.toThrow("outside libraries/charts");
    const empty = html.replace("<p>Inline data</p>", "<canvas></canvas>");
    await expect(
      checkExample(
        fragment(empty, "Without libraries: draw the data inline."),
        "references/charts.md",
      ),
    ).rejects.toThrow("no inline content");
    const sections = examples(
      `## First
Without libraries: keep the inline data.
\`\`\`html
<style></style><p>A</p>
\`\`\`
## Second
\`\`\`html
${html}
\`\`\``,
      "references/charts.md",
    );
    await expect(
      checkExample(sections[1], "references/charts.md"),
    ).rejects.toThrow("Without libraries");
    for (const address of [
      "https://outside.test/library.js",
      "http://cdn.jsdelivr.net/library.js",
      "https://cdn.jsdelivr.net@outside.test/library.js",
      "https://cdn.jsdelivr.net:8443/library.js",
    ]) {
      expect(() => checkUrls(address, "references/libraries.md")).toThrow(
        "default host",
      );
    }
    expect(() =>
      examples("## Partial\n```html\n<style>", "references/art.md"),
    ).toThrow("unclosed fence");
  });
});
