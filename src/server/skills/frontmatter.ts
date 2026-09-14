// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  isSkillName,
  MAX_SKILL_COMPATIBILITY,
  MAX_SKILL_DESCRIPTION,
} from "../../shared/words.ts";
import { BadRequest } from "../lib/errors.ts";
import {
  MAX_ALLOWED_TOOLS,
  MAX_LICENSE,
  MAX_METADATA_KEY,
  MAX_METADATA_KEYS,
  MAX_METADATA_VALUE,
} from "./limits.ts";

export type ParsedSkill = {
  name: string;
  description: string;
  license: string;
  compatibility: string;
  metadata: Record<string, string>;
  allowedTools: string;
  body: string;
};

const KNOWN = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

const cut = (text: string, cap: number) => [...text].slice(0, cap).join("");
const fail = (line: number, words: string): never => {
  throw new BadRequest(`line ${line}: ${words}`);
};

function scalar(text: string, line: number): string {
  const value = text.trim();
  if (value.startsWith("[") || value.startsWith("{")) {
    fail(line, "value must be text");
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length === 1) {
      fail(line, "quoted value is not closed");
    }
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string") fail(line, "value must be text");
      return parsed;
    } catch {
      fail(line, "quoted value is invalid");
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length === 1) {
      fail(line, "quoted value is not closed");
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function block(
  lines: string[],
  start: number,
  style: string,
): { value: string; next: number } {
  let end = start;
  while (
    end < lines.length &&
    (lines[end]!.trim() === "" || /^\s/.test(lines[end]!))
  ) {
    end++;
  }
  const body = lines.slice(start, end);
  const indents = body
    .filter((line) => line.trim() !== "")
    .map((line) => line.match(/^\s*/)![0].length);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  const plain = body.map((line) => line.slice(Math.min(indent, line.length)));
  let value: string;
  if (style.startsWith(">")) {
    value = "";
    for (let i = 0; i < plain.length; i++) {
      const line = plain[i]!;
      const next = plain[i + 1];
      value += line;
      if (next !== undefined) value += line === "" || next === "" ? "\n" : " ";
    }
  } else {
    value = plain.join("\n");
  }
  const chomp = style.slice(1);
  if (chomp === "+") value += "\n";
  else if (chomp !== "-") value = `${value.replace(/\n+$/, "")}\n`;
  else value = value.replace(/\n+$/, "");
  return { value, next: end };
}

export function parseSkillMd(text: string): ParsedSkill {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  if (lines[0] !== "---") throw new BadRequest("the skill has no frontmatter");
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) throw new BadRequest("the frontmatter is not closed");

  const values = new Map<string, string>();
  const metadata: Record<string, string> = {};
  let i = 1;
  while (i < close) {
    const line = lines[i]!;
    const number = i + 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    if (/^\s/.test(line)) fail(number, "unexpected indentation");
    const match = /^([^:]+):(.*)$/.exec(line);
    if (!match) throw new BadRequest(`line ${number}: expected key: value`);
    const key = match[1]!.trim();
    const tail = match[2]!.trim();
    if (!KNOWN.has(key)) {
      i++;
      while (i < close && (lines[i]!.trim() === "" || /^\s/.test(lines[i]!)))
        i++;
      continue;
    }
    if (key === "metadata") {
      if (tail !== "") fail(number, "metadata must be a map");
      i++;
      let count = 0;
      while (i < close && (lines[i]!.trim() === "" || /^\s/.test(lines[i]!))) {
        const nested = lines[i]!;
        if (nested.trim() === "") {
          i++;
          continue;
        }
        const item = /^\s+([^:]+):(.*)$/.exec(nested);
        if (!item) {
          throw new BadRequest(
            `line ${i + 1}: metadata must contain text values`,
          );
        }
        const metaKey = scalar(item[1]!, i + 1);
        const metaValue = scalar(item[2]!, i + 1);
        if (metaKey === "") fail(i + 1, "metadata key is empty");
        if (count < MAX_METADATA_KEYS) {
          metadata[cut(metaKey, MAX_METADATA_KEY)] = cut(
            metaValue,
            MAX_METADATA_VALUE,
          );
        }
        count++;
        i++;
      }
      continue;
    }
    if (/^[>|][+-]?$/.test(tail)) {
      const parsed = block(lines.slice(0, close), i + 1, tail);
      values.set(key, parsed.value);
      i = parsed.next;
      continue;
    }
    values.set(key, scalar(tail, number));
    i++;
  }

  const name = values.get("name") ?? "";
  if (!isSkillName(name)) throw new BadRequest("the skill has an invalid name");
  const description = (values.get("description") ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (description === "") throw new BadRequest("the skill has no description");
  return {
    name,
    description: cut(description, MAX_SKILL_DESCRIPTION),
    license: cut((values.get("license") ?? "").trim(), MAX_LICENSE),
    compatibility: cut(
      (values.get("compatibility") ?? "").trim(),
      MAX_SKILL_COMPATIBILITY,
    ),
    metadata,
    allowedTools: cut(
      (values.get("allowed-tools") ?? "").trim(),
      MAX_ALLOWED_TOOLS,
    ),
    body: lines
      .slice(close + 1)
      .join("\n")
      .replace(/^\n/, ""),
  };
}
