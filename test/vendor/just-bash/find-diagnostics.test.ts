// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// find reports what it cannot read in traversal order, beside the output of
// the node it met it on, as GNU findutils 4.11 find answered the same tree
// on a real disk (its entries put in our sorted order), in the C locale.

import { describe, expect, test } from "bun:test";
import { Bash, type IFileSystem, InMemoryFs } from "just-bash";

// /t/a/f, /t/a/locked/x (unreadable), /t/b/g, /t/b/up -> .., /t/l1 -> b,
// /t/l2 -> l3, /t/l3 -> l2, /t/ll -> a/locked
async function run(script: string, fatal?: string) {
  const memory = new InMemoryFs();
  const failures: Record<string, string> = {
    "/t/a/locked": "EACCES: permission denied, scandir '/t/a/locked'",
  };
  if (fatal) failures[fatal] = "ABORT_ERR: The operation was aborted";
  const fs = new Proxy(memory, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop === "readdir" || prop === "readdirWithFileTypes") {
        return async (path: string, ...rest: unknown[]) => {
          const real = await target.realpath(path).catch(() => path);
          const message = failures[real];
          if (message !== undefined) throw new Error(message);
          return value.call(target, path, ...rest);
        };
      }
      return value.bind(target);
    },
  }) as IFileSystem;
  const bash = new Bash({ fs, cwd: "/" });
  await bash.exec(
    "mkdir -p /t/a/locked /t/b; touch /t/a/f /t/a/locked/x /t/b/g; ln -s .. /t/b/up; ln -s b /t/l1; ln -s l3 /t/l2; ln -s l2 /t/l3; ln -s a/locked /t/ll",
  );
  return bash.exec(script);
}

const denied = (path: string) => `find: '${path}': Permission denied\n`;
const eloop = (path: string) =>
  `find: '${path}': Too many levels of symbolic links\n`;
const cycle = (path: string) =>
  `find: File system loop detected; the following directory is part of the cycle: '${path}'\n`;
const echo = `sh -c 'echo "E $1" >&2' sh {} ';'`;
const e = (...paths: string[]) => paths.map((path) => `E ${path}\n`).join("");

type Case = [string, string, string, number];

const cases: Case[] = [
  [
    "find t",
    "t\nt/a\nt/a/f\nt/a/locked\nt/b\nt/b/g\nt/b/up\nt/l1\nt/l2\nt/l3\nt/ll\n",
    denied("t/a/locked"),
    1,
  ],
  [
    `find -L t -exec ${echo}`,
    "",
    e("t", "t/a", "t/a/f", "t/a/locked") +
      denied("t/a/locked") +
      e("t/b", "t/b/g") +
      cycle("t/b/up") +
      e("t/l1", "t/l1/g") +
      cycle("t/l1/up") +
      eloop("t/l2") +
      eloop("t/l3") +
      e("t/ll") +
      denied("t/ll"),
    1,
  ],
  [
    `find -L t -depth -exec ${echo}`,
    "",
    e("t/a/f") +
      denied("t/a/locked") +
      e("t/a/locked", "t/a", "t/b/g") +
      cycle("t/b/up") +
      e("t/b", "t/l1/g") +
      cycle("t/l1/up") +
      e("t/l1") +
      eloop("t/l2") +
      eloop("t/l3") +
      denied("t/ll") +
      e("t/ll", "t"),
    1,
  ],
  [
    "find -L t -mindepth 2",
    "t/a/f\nt/a/locked\nt/b/g\nt/l1/g\n",
    denied("t/a/locked") +
      cycle("t/b/up") +
      cycle("t/l1/up") +
      eloop("t/l2") +
      eloop("t/l3") +
      denied("t/ll"),
    1,
  ],
  ["find -L t -mindepth 2 -maxdepth 1", "", eloop("t/l2") + eloop("t/l3"), 1],
  [
    "find -L t -maxdepth 1 -name ll",
    "t/ll\n",
    eloop("t/l2") + eloop("t/l3"),
    1,
  ],
  [
    `find t/b missing t/a -exec ${echo}`,
    "",
    e("t/b", "t/b/g", "t/b/up") +
      "find: 'missing': No such file or directory\n" +
      e("t/a", "t/a/f", "t/a/locked") +
      denied("t/a/locked"),
    1,
  ],
  [
    "find t -name locked -prune -o -print",
    "t\nt/a\nt/a/f\nt/b\nt/b/g\nt/b/up\nt/l1\nt/l2\nt/l3\nt/ll\n",
    "",
    0,
  ],
  [
    "find t -size -100k -name locked -prune -o -print",
    "t\nt/a\nt/a/f\nt/b\nt/b/g\nt/b/up\nt/l1\nt/l2\nt/l3\nt/ll\n",
    "",
    0,
  ],
  ["find -L t/ll -prune", "t/ll\n", "", 0],
  ["find t -name locked -prune -o -empty -print", "t/a/f\nt/b/g\n", "", 0],
  [
    "find t -empty -o -name locked -prune",
    "t/a/f\nt/a/locked\nt/b/g\n",
    denied("t/a/locked"),
    1,
  ],
];

describe("find diagnostics", () => {
  for (const [script, stdout, stderr, exitCode] of cases) {
    test(script, async () => {
      const result = await run(script);
      expect(result.stderr).toBe(stderr);
      expect(result.stdout).toBe(stdout);
      expect(result.exitCode).toBe(exitCode);
    });
  }

  test("a failure that is not the folder's own ends the search", async () => {
    const result = await run("find -L t", "/t/b");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ABORT_ERR");
    expect(result.stderr).not.toContain("Too many levels");
    expect(result.exitCode).toBe(1);
  });

  const quoted: [string, string][] = [
    ["nope", "'nope'"],
    ["q/it's x", "'q/it\\'s x'"],
    ["q/a\\b", "'q/a\\\\b'"],
    ["q/a\nb", "'q/a\\nb'"],
    ["q/a\tb", "'q/a\\tb'"],
    ['q/a"b', `'q/a"b'`],
    ["q/caf\u00e9", "'q/caf\\303\\251'"],
    ["q/\x01\x07\b\v\f\r\x7f", "'q/\\001\\a\\b\\v\\f\\r\\177'"],
  ];
  for (const [path, diagnostic] of quoted) {
    test(`quotes a missing path ${JSON.stringify(path)}`, async () => {
      const result = await new Bash({ cwd: "/" }).exec(
        `find '${path.replaceAll("'", "'\\''")}'`,
      );
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `find: ${diagnostic}: No such file or directory\n`,
      );
      expect(result.exitCode).toBe(1);
    });
  }

  test("quotes an unreadable folder, a link error and an ancestor loop", async () => {
    const memory = new InMemoryFs();
    await memory.mkdir("/it's locked");
    await memory.mkdir("/it's parent");
    await memory.symlink("it's loop", "/it's loop");
    await memory.symlink(".", "/it's parent/up");
    const fs = new Proxy(memory, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        if (prop === "readdir" || prop === "readdirWithFileTypes") {
          return async (path: string, ...rest: unknown[]) => {
            if (path === "/it's locked") throw new Error("EACCES: denied");
            return value.call(target, path, ...rest);
          };
        }
        return value.bind(target);
      },
    }) as IFileSystem;
    const result = await new Bash({ fs, cwd: "/" }).exec(
      `find -L "it's locked" "it's loop" "it's parent"`,
    );
    expect(result.stdout).toBe("it's locked\nit's parent\n");
    expect(result.stderr).toBe(
      "find: 'it\\'s locked': Permission denied\n" +
        "find: 'it\\'s loop': Too many levels of symbolic links\n" +
        "find: File system loop detected; the following directory is part of the cycle: 'it\\'s parent/up'\n",
    );
    expect(result.exitCode).toBe(1);
  });
});
