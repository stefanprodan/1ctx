// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type {
  SkillChange,
  SkillSummary,
} from "../../../shared/contracts/skill.ts";
import { sourceForm } from "../../../shared/skills.ts";
import type { SkillSource } from "../../../shared/words.ts";
import { count, longDate, plural, pluralCommas } from "../../lib/format.ts";
import { cutLines } from "../../lib/lines.ts";

export const URL_HINT =
  "A site with skills, a GitHub directory, a raw SKILL.md, or a zip or tar archive.";

export function formKind(url: string): SkillSource | null {
  return sourceForm(url)?.kind ?? null;
}

export function submitLabel(kind: SkillSource | null): string {
  return kind === "index" ? "Look up" : "Add skill";
}

export function urlProblem(url: string): string | null {
  if (url.trim() === "") return "Paste a URL";
  if (formKind(url) === null) return "Not an http(s) URL";
  return null;
}

export function pathProblem(path: string): string | null {
  const p = path.trim();
  if (p === "") return null;
  if (p.startsWith("/") || p.includes("\\")) return "A relative path";
  if (p.split("/").some((s) => s === "..")) return "A path inside the archive";
  return null;
}

export function sourceLine(
  skill: Pick<
    SkillSummary,
    "sourceKind" | "sourceUrl" | "sourceSelect" | "sourceDigest"
  >,
): string {
  const form = sourceForm(skill.sourceUrl);
  switch (skill.sourceKind) {
    case "github":
      return form?.kind === "github"
        ? `GitHub, ${form.ref}, ${form.path === "" ? "the root" : form.path}`
        : "GitHub";
    case "archive":
      return skill.sourceSelect === ""
        ? "Archive, at its root"
        : `Archive, ${skill.sourceSelect}`;
    case "index": {
      const host = form === null ? "" : new URL(skill.sourceUrl).host;
      return `${host === "" ? "Index" : host}, ${
        skill.sourceDigest === "" ? "no digest" : "digest checked"
      }`;
    }
    default:
      return "Raw SKILL.md";
  }
}

export function changeLine(
  change: SkillChange | null,
  fetchedAt: number,
  createdAt: number,
): string {
  if (change === null) return `Same as ${longDate(createdAt)}`;
  if (change.at < fetchedAt) return `Same as ${longDate(change.at)}`;
  const parts: string[] = [];
  if (change.body) parts.push("body changed");
  if (change.description) parts.push("description changed");
  if (change.fields.length > 0) {
    parts.push(`${change.fields.join(", ")} changed`);
  }
  const { added, removed, changed } = change.files;
  if (added.length > 0) parts.push(`${plural(added.length, "file")} added`);
  if (removed.length > 0) {
    parts.push(`${plural(removed.length, "file")} removed`);
  }
  if (changed.length > 0) {
    parts.push(`${plural(changed.length, "file")} changed`);
  }
  if (parts.length === 0) return `Changed ${longDate(change.at)}`;
  const text = parts.join(", ");
  return `${text[0]!.toUpperCase()}${text.slice(1)} ${longDate(change.at)}`;
}

export function droppedLine(
  skill: Pick<SkillSummary, "dropped" | "droppedMore">,
): string {
  if (skill.dropped.length === 0) return "";
  const total = skill.dropped.length + skill.droppedMore;
  const list = skill.dropped.map((d) => `${d.path} (${d.reason})`).join(", ");
  const more = skill.droppedMore > 0 ? ` and ${skill.droppedMore} more` : "";
  return `${pluralCommas(total, "file", "files")} not kept: ${list}${more}`;
}

export const carriersOf = (
  agents: readonly AgentSummary[],
  id: string,
): AgentSummary[] => agents.filter((a) => a.skills.includes(id));

export function skillDeleteLine(carriers: number): string {
  if (carriers === 0) return "No agent carries it.";
  return `${pluralCommas(carriers, "agent carries", "agents carry")} it. Remove it from ${
    carriers === 1 ? "that agent" : "them"
  } first.`;
}

export function metadataLines(metadata: Record<string, string>): string[] {
  return Object.keys(metadata)
    .sort()
    .map((key) => `${key}: ${metadata[key]}`);
}

const TEXT_LINES = 12;

export function textBox(
  text: string,
  expanded: boolean,
): { text: string; cut: boolean; label: string } {
  const box = cutLines(text, TEXT_LINES, expanded);
  const n = box.lines;
  return {
    text: box.text,
    cut: box.cut,
    // count(), since a body may pass 999 lines
    label: `Show all ${count(n)} line${n === 1 ? "" : "s"}`,
  };
}
