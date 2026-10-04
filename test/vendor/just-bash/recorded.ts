// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Runs the cases of a recorded fixture through the vendored shell and
// compares them with what the reference binary answered. stderr is not
// compared, only that a failure or a warning says something.

import { expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import {
  type FileValue,
  type Fixture,
  fileBytes,
  fileValue,
  listTree,
  maskTimes,
  type RecordedCase,
  sortLines,
} from "../../../scripts/record/cases.ts";

export function quote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export async function runCase(
  command: string,
  fixture: Fixture,
  c: RecordedCase,
) {
  const fs = new InMemoryFs({}, {});
  const files = { ...fixture.files, ...c.files };
  const mtime =
    fixture.mtime === undefined ? undefined : new Date(fixture.mtime);
  for (const name of fixture.dirs ?? []) {
    fs.mkdirSync(`/work/${name}`, { recursive: true });
  }
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(`/work/${name}`, fileBytes(value), undefined, { mtime });
  }
  for (const [name, target] of Object.entries(fixture.links ?? {})) {
    await fs.symlink(target, `/work/${name}`);
  }
  const bash = new Bash({
    fs,
    cwd: "/work",
    env: { ...fixture.env, ...c.env },
  });
  const result = await bash.exec(
    [command, ...c.args].map((a, i) => (i === 0 ? a : quote(a))).join(" "),
    { stdin: c.stdin ?? "" },
  );
  const written: Record<string, FileValue> = {};
  for (const [name, value] of Object.entries(files)) {
    // a file the run removed or moved is in the tree, when listed
    const now = await fs.readFileBuffer(`/work/${name}`).catch(() => undefined);
    if (now !== undefined && !Bun.deepEquals(now, fileBytes(value))) {
      written[name] = fileValue(now);
    }
  }
  const tree = fixture.tree
    ? await listTree("/work", {
        readdir: (path) => fs.readdir(path),
        lstat: async (path) => {
          const info = await fs.lstat(path);
          return {
            isDirectory: () => info.isDirectory,
            isSymbolicLink: () => info.isSymbolicLink,
          };
        },
        readlink: (path) => fs.readlink(path),
      })
    : undefined;
  return { ...result, written, tree };
}

/** The stderr and tree a case expects, when its fixture records them. */
function expectedExtras(c: RecordedCase) {
  return {
    stderr: c.accept?.stderr ?? c.stderr,
    tree: c.accept?.tree ?? c.tree,
  };
}

/** What the case expects on stdout, as the shell hands it back. */
function expectedStdout(c: RecordedCase): string {
  if (c.accept) return c.accept.stdout;
  // bytes that are not UTF-8 come back one character per byte
  if (c.stdoutBase64 !== undefined) return atob(c.stdoutBase64);
  return c.stdout as string;
}

function gotStdout(
  c: RecordedCase,
  result: Awaited<ReturnType<typeof runCase>>,
): string {
  const got = c.unordered ? sortLines(result.stdout) : result.stdout;
  return c.maskTimes ? maskTimes(got) : got;
}

function matches(
  c: RecordedCase,
  result: Awaited<ReturnType<typeof runCase>>,
  exactExit: boolean,
): boolean {
  const exit = c.accept ? c.accept.exit : c.exit;
  if (gotStdout(c, result) !== expectedStdout(c)) return false;
  if (
    exactExit
      ? result.exitCode !== exit
      : (exit === 0) !== (result.exitCode === 0)
  ) {
    return false;
  }
  if ((c.error || c.warned) && !c.accept && result.stderr === "") return false;
  const written = c.accept?.written ?? c.written ?? {};
  const { stderr, tree } = expectedExtras(c);
  if (stderr !== undefined && result.stderr !== stderr) return false;
  if (tree !== undefined && !Bun.deepEquals(result.tree, tree)) return false;
  return Bun.deepEquals(result.written, written);
}

/**
 * Runs every case. A case named in `known` is one we still answer
 * differently, and fails when it passes. `exactExit` compares the exit
 * code itself, where a tool's 1 and 2 mean different things.
 */
export function recordedCases(
  command: string,
  fixture: Fixture,
  known: ReadonlySet<string> = new Set(),
  exactExit = false,
): void {
  if (known.size > 0) {
    test("every known difference names a case", () => {
      const names = new Set(fixture.cases.map((c) => c.name));
      expect([...known].filter((name) => !names.has(name))).toEqual([]);
    });
  }
  for (const c of fixture.cases) {
    test(c.name, async () => {
      const result = await runCase(command, fixture, c);
      if (known.has(c.name)) {
        expect(matches(c, result, exactExit)).toBe(false);
        return;
      }
      const exit = c.accept ? c.accept.exit : c.exit;
      expect(gotStdout(c, result)).toBe(expectedStdout(c));
      if (exactExit) expect(result.exitCode).toBe(exit as number);
      else if (exit === 0) expect(result.exitCode).toBe(0);
      else expect(result.exitCode).not.toBe(0);
      if ((c.error || c.warned) && !c.accept) {
        expect(result.stderr).not.toBe("");
      }
      const written = c.accept?.written ?? c.written ?? {};
      expect(result.written).toEqual(written);
      const { stderr, tree } = expectedExtras(c);
      if (stderr !== undefined) expect(result.stderr).toBe(stderr);
      if (tree !== undefined) expect(result.tree).toEqual(tree);
    });
  }
}
