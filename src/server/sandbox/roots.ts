// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Landlock skips a path that does not exist, so an image without one of
// our roots would run with that root outside the policy. The first
// sandbox of an image is checked for every root before any lease uses
// it: each is a folder, not a link, and each the policy lists writable
// takes a file.

import type { Log } from "../lib/log.ts";
import type { Gateway } from "./gateway.ts";
import { POLICY, SANDBOX_ENV } from "./spec.ts";

const OUTPUT_BYTES = 4096;

export const WRITABLE_ROOTS = POLICY.readWrite.filter(
  (path) => !path.startsWith("/dev/"),
);
export const READ_ONLY_ROOTS = ["/repos"];

// one line per problem, then ok; the probe file goes at once, so no
// walk ever sees it
export const ROOTS_SCRIPT = [
  `for r in ${WRITABLE_ROOTS.join(" ")}; do`,
  '  if [[ ! -d $r || -L $r ]]; then echo "missing $r"; continue; fi',
  '  f="$r/.1ctx-root-check"',
  '  if ! { : >"$f"; } 2>/dev/null; then echo "unwritable $r"; continue; fi',
  '  /usr/bin/rm -f -- "$f" || echo "unwritable $r"',
  "done",
  `for r in ${READ_ONLY_ROOTS.join(" ")}; do`,
  '  [[ -d $r && ! -L $r ]] || echo "missing $r"',
  "done",
  "echo ok",
].join("\n");

export const ROOTS_COMMAND = [
  "/usr/bin/bash",
  "--noprofile",
  "--norc",
  "-c",
  ROOTS_SCRIPT,
];

// the problems the script named, each "missing /x" or "unwritable /x";
// null when its answer is not the script's, so nothing is known
export function rootProblems(code: number | null, stdout: string) {
  if (code !== 0) return null;
  const lines = stdout.split("\n").filter((line) => line !== "");
  if (lines.at(-1) !== "ok") return null;
  const problems = lines.slice(0, -1);
  const roots = new Set([...WRITABLE_ROOTS, ...READ_ONLY_ROOTS]);
  const known = problems.every((line) => {
    const [word, root, ...rest] = line.split(" ");
    return (
      (word === "missing" || word === "unwritable") &&
      roots.has(root!) &&
      rest.length === 0
    );
  });
  return known ? problems : null;
}

// a throw when the check could not run; the problems when it did
export async function checkRoots(
  gateway: Gateway,
  sandbox: string,
  signal: AbortSignal,
): Promise<string[]> {
  let code: number | null = null;
  let stdout = "";
  const decoder = new TextDecoder();
  for await (const event of gateway.exec({
    sandbox,
    command: ROOTS_COMMAND,
    environment: { ...SANDBOX_ENV },
    signal,
  })) {
    if ("exit" in event) code = event.exit;
    else if (event.stream === "stdout" && stdout.length < OUTPUT_BYTES) {
      stdout += decoder.decode(event.data, { stream: true });
    }
  }
  const problems = rootProblems(code, stdout);
  if (problems === null) throw new Error("the root check did not answer");
  return problems;
}

// a refusal the image earned, which the leases keep and show the admin
export class ImageRefused extends Error {}

// one image: checked until one sandbox passes, refused for good once
// one fails, since every sandbox of it is made the same way
export class ImageCheck {
  private passed = false;
  refused: ImageRefused | null = null;

  constructor(
    private readonly image: string,
    private readonly log: Log,
  ) {}

  async verify(
    gateway: Gateway,
    sandbox: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.refused !== null) throw this.refused;
    if (this.passed) return;
    const problems = await checkRoots(gateway, sandbox, signal);
    if (this.passed) return;
    if (problems.length === 0) {
      this.passed = true;
      return;
    }
    if (this.refused === null) {
      this.log.warn("sandbox image refused", {
        image: this.image,
        roots: problems.length,
      });
    }
    this.refused ??= new ImageRefused(
      `the sandbox image ${this.image} fails its root check (${problems.join(", ")}). An admin must fix the image or pick another`,
    );
    throw this.refused;
  }
}

// a manager's checks, one per image its projects' variants name
export class ImageChecks {
  private readonly checks = new Map<string, ImageCheck>();

  constructor(private readonly log: Log) {}

  of(image: string): ImageCheck {
    let check = this.checks.get(image);
    if (check === undefined) {
      check = new ImageCheck(image, this.log);
      this.checks.set(image, check);
    }
    return check;
  }

  refused(image: string): ImageRefused | null {
    return this.checks.get(image)?.refused ?? null;
  }

  // a throw of the image's refusal, once one sandbox of it failed
  pass(image: string): void {
    const refused = this.refused(image);
    if (refused !== null) throw refused;
  }
}
