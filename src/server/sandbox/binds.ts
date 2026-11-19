// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Some Docker hosts bind a repository so that every read under it is
// refused (Docker Desktop on the Apple Virtualization framework, whose
// shares take a fake owner), while the image's root check passes. A
// sandbox made with repositories lists each one once, so its command
// names the repository the host cannot share rather than a bare
// Permission denied. A failed bind refuses that sandbox alone, never
// the image.

import type { ShellRepo } from "../bash/index.ts";
import type { Gateway } from "./gateway.ts";
import { SANDBOX_ENV } from "./spec.ts";

const OUTPUT_BYTES = 4096;

// the names come as arguments, never inside the script; each one that
// cannot be listed is named by its place, then ok
export const BINDS_SCRIPT = [
  "i=0",
  'for n in "$@"; do',
  '  /usr/bin/ls -A -- "/repos/$n" >/dev/null 2>&1 || echo "unreadable $i"',
  "  i=$((i + 1))",
  "done",
  "echo ok",
].join("\n");

export const BINDS_COMMAND = [
  "/usr/bin/bash",
  "--noprofile",
  "--norc",
  "-c",
  BINDS_SCRIPT,
  "binds",
];

// the places of the repositories that could not be listed; null when the
// answer is not the script's
export function unreadableBinds(
  code: number | null,
  stdout: string,
  count: number,
): number[] | null {
  if (code !== 0) return null;
  const lines = stdout.split("\n").filter((line) => line !== "");
  if (lines.at(-1) !== "ok") return null;
  const places: number[] = [];
  for (const line of lines.slice(0, -1)) {
    const match = /^unreadable (\d+)$/.exec(line);
    const place = match === null ? -1 : Number(match[1]);
    if (place < 0 || place >= count) return null;
    places.push(place);
  }
  return places;
}

// a repository the host's Docker cannot share: the command's words,
// and how many, which the log takes in place of the names
export class RepoUnshared extends Error {
  constructor(
    message: string,
    readonly unreadable: number,
  ) {
    super(message);
  }
}

export function unsharedWords(names: readonly string[]): string {
  const which =
    names.length === 1
      ? `the repository ${names[0]} cannot`
      : `the repositories ${names.join(", ")} cannot`;
  return `${which} be read in the sandbox: this host's Docker does not share its files. Docker Desktop needs Docker VMM as its virtual machine`;
}

// a throw when the check could not run or a repository cannot be listed
export async function checkBinds(
  gateway: Gateway,
  sandbox: string,
  repos: readonly ShellRepo[],
  signal: AbortSignal,
): Promise<void> {
  if (repos.length === 0) return;
  let code: number | null = null;
  let stdout = "";
  const decoder = new TextDecoder();
  for await (const event of gateway.exec({
    sandbox,
    command: [...BINDS_COMMAND, ...repos.map((repo) => repo.name)],
    environment: { ...SANDBOX_ENV },
    signal,
  })) {
    if ("exit" in event) code = event.exit;
    else if (event.stream === "stdout" && stdout.length < OUTPUT_BYTES) {
      stdout += decoder.decode(event.data, { stream: true });
    }
  }
  const places = unreadableBinds(code, stdout, repos.length);
  if (places === null) throw new Error("the repository check did not answer");
  if (places.length > 0) {
    throw new RepoUnshared(
      unsharedWords(places.map((place) => repos[place]!.name)),
      places.length,
    );
  }
}
