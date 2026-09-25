// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A file's highlight.js language by its extension, shared by `open` and
// the file page so both name a file's language alike.

import { kindOf } from "./text.ts";

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
  htm: "xml",
  html: "xml",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  kt: "kotlin",
  lua: "lua",
  makefile: "makefile",
  markdown: "markdown",
  md: "markdown",
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

export function languageOf(name: string): string | null {
  return LANGUAGES[kindOf(name)] ?? null;
}

export function isMarkdown(name: string): boolean {
  return ["md", "markdown"].includes(kindOf(name));
}
