// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { defineCommand, type FsStat, latin1FromBytes } from "just-bash";
import type { OpenedFile } from "../../shared/contracts/session.ts";
import { kindOf } from "../../shared/knowledge.ts";
import {
  hasLineBreak,
  MAX_TITLE,
  VISUAL_FRAME_BYTES,
} from "../../shared/words.ts";
import { languageOf, lineCount, textFromBytes } from "../knowledge/index.ts";
import { bytesWords } from "../lib/bytes.ts";
import { MAX_OPENS_PER_COMMAND } from "./commands.ts";

export type OpenedRecord = OpenedFile & { text: string };

function entity(value: string): string {
  return value.replace(
    /&(?:#([0-9]+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi,
    (whole, decimal: string, hex: string, named: string) => {
      if (decimal || hex) {
        const point = Number.parseInt(decimal || hex, hex ? 16 : 10);
        if (
          !Number.isSafeInteger(point) ||
          point < 0 ||
          point > 0x10ffff ||
          (point >= 0xd800 && point <= 0xdfff)
        ) {
          return whole;
        }
        return String.fromCodePoint(point);
      }
      return {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        nbsp: "\u00a0",
        quot: '"',
      }[named.toLowerCase()]!;
    },
  );
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function visualTitle(text: string, path: string): string {
  const found = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(text);
  if (found) {
    const title = entity(found[1]!).trim();
    if (title !== "" && title.length <= MAX_TITLE && !hasLineBreak(title)) {
      return title;
    }
  }
  return baseName(path);
}

export const underKnowledge = (path: string) =>
  path === "/knowledge" || path.startsWith("/knowledge/");

// a path the server takes from the command worker, a cwd or an opened
// file: normalized, absolute, in one of the trees
export function mountPath(path: string): boolean {
  const parts = path.split("/").slice(1);
  return (
    path.startsWith("/") &&
    Buffer.byteLength(path) <= 256 &&
    !/\p{Cc}/u.test(path) &&
    ["knowledge", "tmp", "uploads", "mcp"].includes(parts[0] ?? "") &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function mounted(path: string): boolean {
  return ["/knowledge", "/tmp", "/uploads", "/mcp"].some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

function components(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => `/${parts.slice(0, index + 1).join("/")}`);
}

function refusal(arg: string, words: string) {
  return {
    stdout: "",
    stderr: `open: ${arg}: ${words}\n`,
    exitCode: 1,
  };
}

export function openedReceipt(file: OpenedRecord): string {
  if (file.kind === "visual") {
    return `opened ${file.path} for the user as a visual. They see it now, so do not repeat its content.`;
  }
  const kind = file.kind === "markdown" ? "Markdown" : "code";
  return `opened ${file.path} for the user as ${kind}, ${file.lines} lines. They see it now, so do not repeat its content.`;
}

// what open records of a file: the kind by extension and the Visuals row,
// the rest read from the text
export function openedRecord(
  path: string,
  text: string,
  visuals: boolean,
): OpenedRecord {
  const extension = kindOf(path);
  const visual = ["html", "htm", "svg"].includes(extension);
  const bytes = Buffer.byteLength(text, "utf8");
  const kind = ["md", "markdown"].includes(extension)
    ? "markdown"
    : visual && visuals && bytes <= VISUAL_FRAME_BYTES
      ? "visual"
      : "code";
  return {
    path,
    kind,
    language: kind === "code" ? languageOf(path) : null,
    bytes,
    lines: lineCount(text),
    title: kind === "visual" ? visualTitle(text, path) : null,
    text,
  };
}

// the command worker's opened records, held to what open itself allows:
// a mounted path, once, within the count and the file cap, and each
// record exactly what open makes of its text; a command inside could
// post an answer of its own
export function checkOpened(
  records: readonly OpenedRecord[],
  caps: { knowledgeFileBytes: number; visuals: boolean; knowledge: boolean },
): OpenedRecord[] {
  const paths = new Set(records.map((record) => record.path));
  const fits = (record: OpenedRecord) => {
    const made = openedRecord(record.path, record.text, caps.visuals);
    return (
      mountPath(record.path) &&
      (caps.knowledge || !underKnowledge(record.path)) &&
      made.bytes <= caps.knowledgeFileBytes &&
      made.kind === record.kind &&
      made.language === record.language &&
      made.bytes === record.bytes &&
      made.lines === record.lines &&
      made.title === record.title
    );
  };
  if (
    records.length > MAX_OPENS_PER_COMMAND ||
    paths.size !== records.length ||
    !records.every(fits)
  )
    throw new Error("the command worker answered out of protocol");
  return [...records];
}

export function makeOpenCommand(
  caps: { knowledgeFileBytes: number; visuals: boolean; knowledge: boolean },
  collect: OpenedRecord[],
) {
  return defineCommand(
    "open",
    async (args, ctx) => {
      if (
        args.length !== 1 ||
        args[0]!.startsWith("-") ||
        latin1FromBytes(ctx.stdin) !== ""
      ) {
        return { stdout: "", stderr: "usage: open <file>\n", exitCode: 1 };
      }
      const arg = args[0]!;
      const path = ctx.fs.resolvePath(ctx.cwd, arg);
      if (!mounted(path)) return refusal(arg, "not in the mount");
      // with the docs off a file made under /knowledge is discarded, so
      // it is missing here too
      if (!caps.knowledge && underKnowledge(path))
        return refusal(arg, "no such file");
      let final: FsStat | undefined;
      try {
        for (const component of components(path)) {
          const stat = await ctx.fs.lstat(component);
          if (stat.isSymbolicLink) return refusal(arg, "not a regular file");
          final = stat;
        }
      } catch {
        return refusal(arg, "no such file");
      }
      if (!final?.isFile) return refusal(arg, "not a regular file");
      const bytes = await ctx.fs.readFileBuffer(path);
      if (bytes.byteLength > caps.knowledgeFileBytes) {
        return refusal(
          arg,
          `over ${bytesWords(caps.knowledgeFileBytes)}, open a smaller part (sed -n '1,200p' f > /tmp/part.md)`,
        );
      }
      const existing = collect.findIndex((file) => file.path === path);
      if (existing < 0 && collect.length >= MAX_OPENS_PER_COMMAND) {
        return refusal(
          arg,
          `at most ${MAX_OPENS_PER_COMMAND} files per command`,
        );
      }
      let text: string;
      try {
        text = textFromBytes(bytes);
      } catch {
        return refusal(arg, "not text");
      }
      const record = openedRecord(path, text, caps.visuals);
      if (existing < 0) collect.push(record);
      else collect[existing] = record;
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    { trusted: false },
  );
}
