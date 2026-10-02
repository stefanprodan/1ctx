// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The names an archive member may take: a skill's files and a
// repository's tree are held to one rule.

// GNU tar commonly prefixes every member with "./". Empty and ".."
// segments stay in place so validation still refuses unsafe paths.
export function normalizePath(path: string): string {
  return path
    .split("/")
    .filter((part) => part !== ".")
    .join("/");
}

export function validPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
  for (const char of path) {
    const code = char.codePointAt(0)!;
    if (
      char === "<" ||
      char === ">" ||
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return false;
    }
  }
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}
