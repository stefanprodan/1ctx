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
import { bytesWords } from "../lib/bytes.ts";
import { MAX_OPENS_PER_COMMAND } from "./limits.ts";
import { lineCount, textFromBytes } from "./text.ts";

export type OpenedRecord = OpenedFile & { text: string };

const LANGUAGES: Record<string, string> = {
  bash: "bash",
  c: "c",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dart: "dart",
  diff: "diff",
  dockerfile: "dockerfile",
  ex: "elixir",
  exs: "elixir",
  go: "go",
  graphql: "graphql",
  h: "c",
  hpp: "cpp",
  hs: "haskell",
  html: "xml",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  kt: "kotlin",
  lua: "lua",
  makefile: "makefile",
  mjs: "javascript",
  nix: "nix",
  patch: "diff",
  php: "php",
  pl: "perl",
  proto: "protobuf",
  py: "python",
  r: "r",
  rb: "ruby",
  rs: "rust",
  scala: "scala",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

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

export function makeOpenCommand(
  caps: { knowledgeFileBytes: number; visuals: boolean },
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
      const extension = kindOf(path);
      const visual = ["html", "htm", "svg"].includes(extension);
      const kind = ["md", "markdown"].includes(extension)
        ? "markdown"
        : visual &&
            caps.visuals &&
            Buffer.byteLength(text, "utf8") <= VISUAL_FRAME_BYTES
          ? "visual"
          : "code";
      const record: OpenedRecord = {
        path,
        kind,
        language: kind === "code" ? (LANGUAGES[extension] ?? null) : null,
        bytes: Buffer.byteLength(text, "utf8"),
        lines: lineCount(text),
        title: kind === "visual" ? visualTitle(text, path) : null,
        text,
      };
      if (existing < 0) collect.push(record);
      else collect[existing] = record;
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    { trusted: false },
  );
}
