// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The mount's paths, pure so every backend and the worker share them.

import { hasLineBreak } from "../../shared/words.ts";
import { isScratchName, MAX_MOUNT_PATH_BYTES } from "./names.ts";

const MOUNT_ROOTS = ["knowledge", "tmp", "uploads", "mcp", "repos"];

// one of the trees, or under one
export const underRoot = (path: string) =>
  MOUNT_ROOTS.some(
    (root) => path === `/${root}` || path.startsWith(`/${root}/`),
  );

// every prefix of an absolute path, the path itself last
export function prefixes(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => `/${parts.slice(0, index + 1).join("/")}`);
}

export const underKnowledge = (path: string) =>
  path === "/knowledge" || path.startsWith("/knowledge/");

// a path the server takes from the command worker, a cwd or an opened
// file: normalized, absolute, in one of the trees, on one line, and
// under /tmp by the scratch rule
export function mountPath(path: string): boolean {
  const parts = path.split("/").slice(1);
  return (
    path.startsWith("/") &&
    path.isWellFormed() &&
    Buffer.byteLength(path) <= MAX_MOUNT_PATH_BYTES &&
    !/\p{Cc}/u.test(path) &&
    !hasLineBreak(path) &&
    MOUNT_ROOTS.includes(parts[0] ?? "") &&
    parts.every((part) => part !== "" && part !== "." && part !== "..") &&
    (!path.startsWith("/tmp/") || isScratchName(path.slice("/tmp/".length)))
  );
}

// an absolute path with . and .. resolved, as just-bash resolves a cwd,
// so a cwd reads the same whichever shell reported it
export function normalizePath(path: string): string {
  if (!path || path === "/") return "/";
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const resolved: string[] = [];
  for (const part of trimmed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return `/${resolved.join("/")}`;
}
