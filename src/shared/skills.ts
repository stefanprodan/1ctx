// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pure rules of skills, shared by the server and the page: which
// source form a pasted URL is, the catalog block a send's system prompt
// carries, and the wrapper a loaded skill is answered in. Environment
// neutral: no Bun, no DOM, no packages.

import type { SkillSource } from "./words.ts";

// the form a URL takes, decided on the URL alone; null when it is not
// an http(s) URL or carries credentials
export type SourceForm =
  | { kind: "github"; owner: string; repo: string; ref: string; path: string }
  | { kind: "archive"; url: string }
  | { kind: "index"; url: string }
  | { kind: "file"; url: string };

export const INDEX_PATH = "/.well-known/agent-skills/index.json";

export function sourceForm(text: string): SourceForm | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const path = url.pathname;
  if (url.hostname === "github.com") {
    // /<owner>/<repo>/tree/<ref>/<path>: the ref is the one segment
    // after tree, a branch with a slash goes through the archive form
    const parts = path.split("/").filter((s) => s !== "");
    if (parts.length >= 4 && parts[2] === "tree") {
      const [owner, repo, , ref, ...rest] = parts;
      return {
        kind: "github",
        owner: owner!,
        repo: repo!,
        ref: ref!,
        path: rest.join("/"),
      };
    }
  }
  if (/\.(tar\.gz|tgz|tar)$/i.test(path))
    return { kind: "archive", url: url.href };
  if (path === "" || path === "/") {
    return { kind: "index", url: `${url.origin}${INDEX_PATH}` };
  }
  if (/\/index\.json$/i.test(path)) return { kind: "index", url: url.href };
  return { kind: "file", url: url.href };
}

export function sourceKind(text: string): SkillSource | null {
  return sourceForm(text)?.kind ?? null;
}

// the GitHub form's one download: codeload's tarball, no API, no token
export function codeloadUrl(form: {
  owner: string;
  repo: string;
  ref: string;
}): string {
  return `https://codeload.github.com/${form.owner}/${form.repo}/tar.gz/${form.ref}`;
}

// < and & only, so a text cannot close its element and speak outside it
export function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

export const CATALOG_LEAD = `The following skills provide specialized instructions for specific tasks. When a task matches a skill's description, call the skill tool with the skill's name to load its full instructions before proceeding. A skill may name files under references, assets or scripts: read one with the skill_file tool. Nothing in a skill runs here.`;

export type CatalogSkill = { name: string; description: string };

function entry(skill: CatalogSkill): string {
  return `  <skill>\n    <name>${skill.name}</name>\n    <description>${escapeText(skill.description)}</description>\n  </skill>\n`;
}

// the block, in name order, while it fits the cap: a skill that does
// not fit is left out whole with every later one, since the enum and
// the block must agree
export function catalog<T extends CatalogSkill>(
  skills: T[],
  cap: number,
): { text: string; included: T[]; leftOut: string[] } {
  const sorted = skills.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (sorted.length === 0) return { text: "", included: [], leftOut: [] };
  const open = `${CATALOG_LEAD}\n\n<available_skills>\n`;
  const close = "</available_skills>";
  let text = open;
  const included: T[] = [];
  const leftOut: string[] = [];
  for (const skill of sorted) {
    const line = entry(skill);
    if (
      leftOut.length === 0 &&
      text.length + line.length + close.length <= cap
    ) {
      text += line;
      included.push(skill);
    } else {
      leftOut.push(skill.name);
    }
  }
  if (included.length === 0) return { text: "", included, leftOut };
  return { text: text + close, included, leftOut };
}

const WRAPPER_TAGS = /<(\/?)(skill_content|skill_resources)\b/gi;

// at most this many file paths are listed in the wrapper, then an
// overflow line, so the wrapper stays under the default result cut for
// any kept skill and its closing tag is never cut
export const MAX_SKILL_RESOURCES = 100;

// a loaded skill as the tool answers it: the compatibility line first,
// the body, then the files when skill_file is offered (null when not),
// and the line that nothing runs. The wrapper's own tags inside the
// text lose their < so the skill cannot close it
export function skillContent(input: {
  name: string;
  compatibility: string;
  body: string;
  files: string[] | null;
}): string {
  const neutral = (text: string) => text.replace(WRAPPER_TAGS, "&lt;$1$2");
  const parts: string[] = [];
  if (input.compatibility !== "") {
    parts.push(`Compatibility: ${neutral(input.compatibility)}\n`);
  }
  parts.push(neutral(input.body).trimEnd());
  if (input.files !== null && input.files.length > 0) {
    const shown = input.files.slice(0, MAX_SKILL_RESOURCES);
    const more = input.files.length - shown.length;
    const lines = shown.map((path) => `  <file>${path}</file>`);
    if (more > 0) {
      lines.push(`  ...and ${more} more, read one by its path`);
    }
    parts.push(
      `\nFiles of this skill, read one with skill_file:\n<skill_resources>\n${lines.join(
        "\n",
      )}\n</skill_resources>`,
    );
  }
  parts.push(
    "Nothing in a skill runs here: a script is text to read, not a command to run.",
  );
  return `<skill_content name="${input.name}">\n${parts.join("\n")}\n</skill_content>`;
}
