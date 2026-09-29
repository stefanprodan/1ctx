// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// rm and find over symbolic links, as GNU coreutils 9.11 rm and GNU
// findutils 4.11 find answer on Linux: rm removes a link, never what it
// names, unless a trailing slash resolves it; find follows links under -L
// everywhere and under -H in the starting points only, -P the default.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

// a/d/f, a/ld -> d, a/d/up -> .., a/broken -> nowhere, la -> a,
// file and fl -> file
async function run(script: string) {
  const bash = new Bash({ cwd: "/w" });
  await bash.exec(
    "mkdir -p /w/a/d; touch /w/a/d/f; ln -s d /w/a/ld; ln -s .. /w/a/d/up; ln -s nowhere /w/a/broken; ln -s a /w/la; touch /w/file; ln -s file /w/fl",
  );
  return bash.exec(script);
}

const loop = (path: string) =>
  `find: File system loop detected; the following directory is part of the cycle: '${path}'\n`;

type Case = [string, string, string, number];

const rm: Case[] = [
  ["rm a/ld; ls a", "broken\nd\n", "", 0],
  ["rm -r a/ld; ls a/d", "f\nup\n", "", 0],
  ["rm la; ls /w a", "/w:\na\nfile\nfl\n\na:\nbroken\nd\nld\n", "", 0],
  ["rm a/broken; ls a", "d\nld\n", "", 0],
  ["rm la/d/f; ls a/d", "up\n", "", 0],
  ["rm a/ld/", "", "rm: cannot remove 'a/ld/': Is a directory\n", 1],
  [
    "rm -r a/ld/; ls a a/d",
    "a:\nbroken\nd\nld\n\na/d:\n",
    "rm: cannot remove 'a/ld/': Not a directory\n",
    0,
  ],
  ["rm -rf a/ld/; ls a/d; ls a", "broken\nd\nld\n", "", 0],
  ["rm -r la/; ls -A a", "", "rm: cannot remove 'la/': Not a directory\n", 0],
  ["rm fl/", "", "rm: cannot remove 'fl/': Not a directory\n", 1],
  ["rm file/", "", "rm: cannot remove 'file/': Not a directory\n", 1],
  ["rm -f fl/; ls fl", "fl\n", "", 0],
  [
    "rm a/broken/",
    "",
    "rm: cannot remove 'a/broken/': No such file or directory\n",
    1,
  ],
];

const find: Case[] = [
  ["find a", "a\na/broken\na/d\na/d/f\na/d/up\na/ld\n", "", 0],
  ["find -P a", "a\na/broken\na/d\na/d/f\na/d/up\na/ld\n", "", 0],
  ["find la", "la\n", "", 0],
  ["find -L -P la", "la\n", "", 0],
  ["find -H la", "la\nla/broken\nla/d\nla/d/f\nla/d/up\nla/ld\n", "", 0],
  ["find -H la -maxdepth 1", "la\nla/broken\nla/d\nla/ld\n", "", 0],
  [
    "find -L a",
    "a\na/broken\na/d\na/d/f\na/ld\na/ld/f\n",
    loop("a/d/up") + loop("a/ld/up"),
    1,
  ],
  [
    "find -L la -type d",
    "la\nla/d\nla/ld\n",
    loop("la/d/up") + loop("la/ld/up"),
    1,
  ],
  ["find -P -L a -maxdepth 1 -name ld -type d", "a/ld\n", "", 0],
  ["find -L a -maxdepth 1 -type f", "", "", 0],
  ["find -L a/broken", "a/broken\n", "", 0],
  ["find a/broken", "a/broken\n", "", 0],
  ["find -H a/broken", "a/broken\n", "", 0],
  ["find -L -- la -maxdepth 0 -type d", "la\n", "", 0],
  ["find -- a -maxdepth 0", "a\n", "", 0],
  ["find -HL la", "", "find: unknown predicate '-HL'\n", 1],
  ["find -L . -maxdepth 1 -type d", ".\n./a\n./la\n", "", 0],
];

describe("symbolic links", () => {
  for (const [script, stdout, stderr, exitCode] of [...rm, ...find]) {
    test(script, async () => {
      const result = await run(script);
      expect(result.stderr).toBe(stderr);
      expect(result.stdout).toBe(stdout);
      expect(result.exitCode).toBe(exitCode);
    });
  }
});

// /real/dir/file, /alias -> /real, /outer -> /alias/dir: a link whose
// target runs through another link resolves one component at a time
async function nested(script: string) {
  const bash = new Bash({ cwd: "/" });
  await bash.exec(
    "mkdir -p /real/dir; echo x > /real/dir/file; ln -s /real /alias; ln -s /alias/dir /outer; ln -s ../alias/dir /real/up",
  );
  return bash.exec(script);
}

const nestedCases: Case[] = [
  ["ls /outer", "file\n", "", 0],
  ["cat /outer/file", "x\n", "", 0],
  ["cat /real/up/file", "x\n", "", 0],
  ["find -L /outer", "/outer\n/outer/file\n", "", 0],
  ["find -H /outer -type f", "/outer/file\n", "", 0],
  ["rm /outer/file; ls /real/dir", "", "", 0],
  [
    "rm -r /outer/; ls -A /real/dir; ls /outer",
    "",
    "rm: cannot remove '/outer/': Not a directory\n",
    0,
  ],
];

// /d/a -> b, /d/b -> a, /d/f: a loop of links, as GNU find 4.11 answers
async function looped(script: string) {
  const bash = new Bash({ cwd: "/" });
  await bash.exec("mkdir /d; touch /d/f; ln -s b /d/a; ln -s a /d/b");
  return bash.exec(script);
}

const eloop = (path: string) =>
  `find: '${path}': Too many levels of symbolic links\n`;

const loopCases: Case[] = [
  ["find /d", "/d\n/d/a\n/d/b\n/d/f\n", "", 0],
  ["find -L /d", "/d\n/d/f\n", eloop("/d/a") + eloop("/d/b"), 1],
  ["find -L /d -type f", "/d/f\n", eloop("/d/a") + eloop("/d/b"), 1],
  ["find -L /d/a", "", eloop("/d/a"), 1],
  ["rm /d/a; ls /d", "b\nf\n", "", 0],
];

describe("links through links", () => {
  for (const [script, stdout, stderr, exitCode] of nestedCases) {
    test(script, async () => {
      const result = await nested(script);
      expect(result.stderr).toBe(stderr);
      expect(result.stdout).toBe(stdout);
      expect(result.exitCode).toBe(exitCode);
    });
  }
  for (const [script, stdout, stderr, exitCode] of loopCases) {
    test(script, async () => {
      const result = await looped(script);
      expect(result.stderr).toBe(stderr);
      expect(result.stdout).toBe(stdout);
      expect(result.exitCode).toBe(exitCode);
    });
  }
});
