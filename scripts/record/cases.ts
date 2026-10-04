// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records what a reference binary answers for each case of a fixture under
// test/fixtures/just-bash/, for yq.ts, jq.ts, grep.ts, rg.ts,
// xargs.ts and diff.ts. Run by hand;
// the suite reads the fixture and never needs the binary.

import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A file's text, or its bytes when they are not text. */
export type FileValue = string | { base64: string };

export interface RecordedCase {
  name: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
  /** files of this case alone, beside the fixture's shared ones */
  files?: Record<string, FileValue>;
  stdout?: string;
  /** stdout's bytes, in place of stdout, when they are not UTF-8 */
  stdoutBase64?: string;
  exit?: number;
  /** the binary failed with words on stderr */
  error?: boolean;
  /** the binary succeeded with words on stderr */
  warned?: boolean;
  /** stdout's lines in no fixed order, compared sorted */
  unordered?: boolean;
  /** header times are masked on both sides, for stdin's current time */
  maskTimes?: boolean;
  /** every file the run changed, as it was left */
  written?: Record<string, FileValue>;
  /** stderr's words, when the fixture compares them */
  stderr?: string;
  /** every path left after the run, when the fixture lists them */
  tree?: string[];
  /** ours where it differs on purpose, with the reason */
  accept?: {
    stdout: string;
    exit: number;
    reason: string;
    written?: Record<string, FileValue>;
    stderr?: string;
    tree?: string[];
  };
}

export interface Fixture {
  recordedWith: string;
  /** the environment of every case, under each case's own */
  env?: Record<string, string>;
  /** names may hold directories */
  files: Record<string, FileValue>;
  /** directories made even when empty */
  dirs?: string[];
  /** symbolic links, each name to its target, made after the files */
  links?: Record<string, string>;
  /** the modification time of every file, as an ISO date */
  mtime?: string;
  /** stderr is recorded and compared word for word */
  stderr?: boolean;
  /** the paths left after each run are recorded and compared */
  tree?: boolean;
  cases: RecordedCase[];
}

/**
 * Every path under a folder, sorted: a folder with a trailing slash, a
 * link as `name -> target`. The suite lists its own tree the same way.
 */
export async function listTree(
  root: string,
  read: {
    readdir(path: string): Promise<string[]>;
    lstat(
      path: string,
    ): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
    readlink(path: string): Promise<string>;
  },
): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    for (const name of await read.readdir(dir)) {
      const full = `${dir}/${name}`;
      const info = await read.lstat(full);
      if (info.isSymbolicLink()) {
        paths.push(`${prefix}${name} -> ${await read.readlink(full)}`);
      } else if (info.isDirectory()) {
        paths.push(`${prefix}${name}/`);
        await walk(full, `${prefix}${name}/`);
      } else paths.push(`${prefix}${name}`);
    }
  };
  await walk(root, "");
  return paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function fileBytes(value: FileValue): Uint8Array {
  return typeof value === "string"
    ? new TextEncoder().encode(value)
    : Uint8Array.from(atob(value.base64), (c) => c.charCodeAt(0));
}

/** Bytes as a FileValue: text when they are UTF-8. */
export function fileValue(bytes: Uint8Array): FileValue {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { base64: btoa(binary) };
  }
}

const HEADER_TIME =
  /^((?:\*\*\*|---|\+\+\+) .*\t)\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{9} [+-]\d{4}$/gm;

/** A diff header's times replaced, since stdin's is the current time. */
export function maskTimes(text: string): string {
  return text.replace(HEADER_TIME, "$1TIME");
}

/** The lines of a text in code point order, for unordered answers. */
export function sortLines(text: string): string {
  if (text === "") return text;
  const lines = text.endsWith("\n")
    ? text.slice(0, -1).split("\n")
    : text.split("\n");
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `${lines.join("\n")}\n`;
}

export async function record(
  binary: string,
  fixturePath: string,
  expectVersion: RegExp,
  options: {
    /** given to the binary alone, never written into the fixture */
    env?: Record<string, string>;
    /** a case without stdin gets /dev/null, never an empty pipe */
    nullStdin?: boolean;
    /** the name the binary is run under, for its messages */
    argv0?: string;
  } = {},
): Promise<void> {
  const version = Bun.spawnSync([binary, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const said =
    `${version.stdout.toString()}${version.stderr.toString()}`.trim();
  if (version.exitCode !== 0 || !expectVersion.test(said)) {
    console.error(`${binary} is not the reference binary: ${said || "none"}`);
    process.exit(1);
  }
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
  fixture.recordedWith = said;
  const names = new Set<string>();
  const moved: string[] = [];
  for (const c of fixture.cases) {
    if (names.has(c.name)) throw new Error(`duplicate case: ${c.name}`);
    names.add(c.name);
    // never where the fixtures live: an -i case writes its files
    const dir = await mkdtemp(join(tmpdir(), "record-"));
    try {
      const files = { ...fixture.files, ...c.files };
      for (const name of fixture.dirs ?? []) {
        await mkdir(join(dir, name), { recursive: true });
      }
      for (const [name, value] of Object.entries(files)) {
        await mkdir(dirname(join(dir, name)), { recursive: true });
        await writeFile(join(dir, name), fileBytes(value));
      }
      for (const [name, target] of Object.entries(fixture.links ?? {})) {
        await mkdir(dirname(join(dir, name)), { recursive: true });
        await symlink(target, join(dir, name));
      }
      if (fixture.mtime !== undefined) {
        const time = new Date(fixture.mtime);
        for (const name of Object.keys(files)) {
          await utimes(join(dir, name), time, time);
        }
      }
      const run = Bun.spawnSync([binary, ...c.args], {
        argv0: options.argv0,
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          ...fixture.env,
          ...c.env,
          ...options.env,
        },
        stdin:
          c.stdin === undefined && options.nullStdin
            ? "ignore"
            : new TextEncoder().encode(c.stdin ?? ""),
        stdout: "pipe",
        stderr: "pipe",
      });
      const written: Record<string, FileValue> = {};
      for (const [name, value] of Object.entries(files)) {
        // a file the run removed or moved is in the tree, when listed
        const now = await readFile(join(dir, name)).then(
          (bytes) => new Uint8Array(bytes),
          () => undefined,
        );
        if (now !== undefined && !Bun.deepEquals(now, fileBytes(value))) {
          written[name] = fileValue(now);
        }
      }
      const tree = fixture.tree
        ? await listTree(dir, {
            readdir: (path) => readdir(path),
            lstat: (path) => lstat(path),
            readlink: (path) => readlink(path),
          })
        : undefined;
      const stderr = fixture.stderr ? run.stderr.toString() : undefined;
      const said = run.stderr.toString().trim() !== "";
      const out = fileValue(new Uint8Array(run.stdout));
      let stdout = typeof out === "string" ? out : undefined;
      if (stdout !== undefined && c.unordered) stdout = sortLines(stdout);
      if (stdout !== undefined && c.maskTimes) stdout = maskTimes(stdout);
      const next = {
        stdout,
        stdoutBase64: typeof out === "string" ? undefined : out.base64,
        exit: run.exitCode ?? -1,
        error: run.exitCode !== 0 && said,
        warned: run.exitCode === 0 && said,
        written,
      };
      const before = JSON.stringify([
        c.stdout,
        c.stdoutBase64,
        c.exit,
        c.error,
        c.warned,
        c.written,
        c.stderr,
        c.tree,
      ]);
      if (next.stdout !== undefined) c.stdout = next.stdout;
      else delete c.stdout;
      if (next.stdoutBase64 !== undefined) c.stdoutBase64 = next.stdoutBase64;
      else delete c.stdoutBase64;
      c.exit = next.exit;
      if (next.error) c.error = true;
      else delete c.error;
      if (next.warned) c.warned = true;
      else delete c.warned;
      if (Object.keys(written).length > 0) c.written = written;
      else delete c.written;
      if (stderr !== undefined) c.stderr = stderr;
      else delete c.stderr;
      if (tree !== undefined) c.tree = tree;
      else delete c.tree;
      const after = JSON.stringify([
        c.stdout,
        c.stdoutBase64,
        c.exit,
        c.error,
        c.warned,
        c.written,
        c.stderr,
        c.tree,
      ]);
      if (before !== after) {
        moved.push(c.name);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${fixture.cases.length} cases recorded with ${said}`);
  for (const name of moved) console.log(`moved: ${name}`);
}
