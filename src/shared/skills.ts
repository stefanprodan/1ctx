// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pure rules of skills, shared by the server and the page: which
// source form a pasted URL is, the catalog block a send's system prompt
// carries, and the wrapper a loaded skill is answered in. Environment
// neutral: no Bun, no DOM, no packages.

import { firstSentence, MAX_CATALOG_LINE } from "./text.ts";
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
  if (/\.(tar\.gz|tgz|tar|zip)$/i.test(path))
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

// < and & only, so a text cannot close its element and speak outside it
export function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

export const CATALOG_LEAD = `The following skills provide specialized instructions for specific tasks. When a task matches a skill's description, call the skill tool with the skill's name to load its full instructions before proceeding. A skill may name files under references, assets or scripts: read one with the skill_file tool. Nothing in a skill runs here.`;

// with names alone there is no description to match a task against
const NAME_LEAD = CATALOG_LEAD.replace(
  "matches a skill's description",
  "matches a skill's name",
);

// what each tier's entries hold, said after the lead
export const SKILL_CATALOG_OPENINGS = [
  "COMPLETE: every skill with its description.",
  "PARTIAL: every skill with the first sentence of its description.",
  "PARTIAL: skill names only; load one with the skill tool to read what it does.",
] as const;

export type CatalogSkill = { name: string; description: string };

// a tier's lead and what an entry keeps of the description, longest first
const TIERS: { lead: string; description: (text: string) => string | null }[] =
  [
    { lead: CATALOG_LEAD, description: (text) => text },
    {
      lead: CATALOG_LEAD,
      description: (text) => firstSentence(text, MAX_CATALOG_LINE),
    },
    { lead: NAME_LEAD, description: () => null },
  ];

function entry(name: string, description: string | null): string {
  const about =
    description === null
      ? ""
      : `    <description>${escapeText(description)}</description>\n`;
  return `  <skill>\n    <name>${name}</name>\n${about}  </skill>\n`;
}

// Every skill, in name order, at the first tier whose whole text fits
// the cap: the cap shortens entries and never removes a skill, since
// the block is the only list of names the model gets. Tier 3 is
// printed over the cap rather than dropping anything; overCap tells
// the caller to say so.
export function catalog(
  skills: CatalogSkill[],
  cap: number,
): { text: string; overCap: boolean } {
  if (skills.length === 0) return { text: "", overCap: false };
  const sorted = skills.slice().sort((a, b) => a.name.localeCompare(b.name));
  let text = "";
  for (const [tier, { lead, description }] of TIERS.entries()) {
    const body = sorted
      .map((skill) => entry(skill.name, description(skill.description)))
      .join("");
    text = `${lead}\n${SKILL_CATALOG_OPENINGS[tier]}\n\n<available_skills>\n${body}</available_skills>`;
    if (text.length <= cap) return { text, overCap: false };
  }
  return { text, overCap: true };
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
