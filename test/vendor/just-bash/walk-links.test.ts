// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The walkers over a repository whose links loop back (`a -> .`,
// `sub/b -> ..`, `sub/deep/c -> .`) and chain (`c1 -> c2 -> sub`), mounted
// read-only with the box on: each passes over a link below its operand as
// its GNU tool does, follows one only when asked, stops at a link back into
// a folder it is inside, and counts toward the traversal limits.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bash, InMemoryFs, MountableFs, OverlayFs } from "just-bash";
import { KNOWLEDGE_COMMANDS } from "../../../src/server/bash/commands.ts";

let repo = "";

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "walk-links-"));
  await mkdir(join(repo, "sub/deep"), { recursive: true });
  for (const file of ["x1", "x2", "sub/x3", "sub/deep/x4"])
    await writeFile(join(repo, file), "x\n");
  await symlink(".", join(repo, "a"));
  await symlink("..", join(repo, "sub/b"));
  await symlink(".", join(repo, "sub/deep/c"));
  await symlink("c2", join(repo, "c1"));
  await symlink("sub", join(repo, "c2"));
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

function shell(executionLimits = {}) {
  const fs = new MountableFs({ base: new InMemoryFs() });
  fs.mkdirSync("/tmp", { recursive: true });
  fs.mount(
    "/repos/r",
    new OverlayFs({
      root: repo,
      mountPoint: "/",
      readOnly: true,
      allowSymlinks: true,
    }),
  );
  return new Bash({
    fs,
    cwd: "/tmp",
    commands: [...KNOWLEDGE_COMMANDS],
    defenseInDepth: true,
    executionLimits: { maxExecutionTimeMs: 10_000, ...executionLimits },
  });
}

const lines = (...items: string[]) => `${items.join("\n")}\n`;

const files = ["sub/deep/x4", "sub/x3", "x1", "x2"].map((f) => `/repos/r/${f}`);

const loops = (say: (path: string) => string) =>
  ["a", "c1/b", "c1/deep/c", "c2/b", "c2/deep/c", "sub/b", "sub/deep/c"]
    .map((path) => say(`/repos/r/${path}`))
    .join("");

describe("walkers over links that loop", () => {
  test("tree lists a link with its target and does not enter it", async () => {
    expect(await shell().exec("tree /repos/r")).toMatchObject({
      stdout: lines(
        "/repos/r",
        "|-- a -> .",
        "|-- c1 -> c2",
        "|-- c2 -> sub",
        "|-- sub",
        "|   |-- b -> ..",
        "|   |-- deep",
        "|   |   |-- c -> .",
        "|   |   `-- x4",
        "|   `-- x3",
        "|-- x1",
        "`-- x2",
        "",
        "7 directories, 4 files",
      ),
      stderr: "",
      exitCode: 0,
    });
  });

  test("tree -l follows a link but not one back into a folder above", async () => {
    const result = await shell().exec("tree -l /repos/r");
    expect(result).toMatchObject({ stderr: "", exitCode: 0 });
    expect(result.stdout).toContain("|-- a -> .  [recursive, not followed]\n");
    expect(result.stdout).toContain(
      "|-- c1 -> c2\n|   |-- b -> ..  [recursive, not followed]\n",
    );
    expect(result.stdout).toEndWith("\n13 directories, 8 files\n");
  });

  test("tree counts toward the traversal limit", async () => {
    const result = await shell({ maxTraversalEntries: 4 }).exec(
      "tree -l /repos/r",
    );
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("entry limit exceeded (4)");
  });

  test("grep -r passes over every link below the operand", async () => {
    expect(await shell().exec("grep -rl x /repos/r")).toMatchObject({
      stdout: lines(...files),
      stderr: "",
      exitCode: 0,
    });
  });

  test("grep -R follows links and warns at each loop", async () => {
    expect(await shell().exec("grep -Rl x /repos/r")).toMatchObject({
      stdout: lines(
        "/repos/r/c1/deep/x4",
        "/repos/r/c1/x3",
        "/repos/r/c2/deep/x4",
        "/repos/r/c2/x3",
        ...files,
      ),
      stderr: loops((p) => `grep: ${p}: warning: recursive directory loop\n`),
      exitCode: 0,
    });
  });

  test("grep -R counts toward the traversal limit", async () => {
    const result = await shell({ maxTraversalEntries: 4 }).exec(
      "grep -Rl x /repos/r",
    );
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("entry limit exceeded (4)");
  });

  test("find -L stops at each loop", async () => {
    const result = await shell().exec("find -L /repos/r");
    expect(result.stdout.split("\n").length).toBe(16);
    expect(result.stderr).toBe(
      loops(
        (p) =>
          `find: File system loop detected; the following directory is part of the cycle: '${p}'\n`,
      ),
    );
    expect(result.exitCode).toBe(1);
  });

  test("ls -R does not enter a link", async () => {
    expect(await shell().exec("ls -R /repos/r")).toMatchObject({
      stdout: lines(
        "/repos/r:",
        "a",
        "c1",
        "c2",
        "sub",
        "x1",
        "x2",
        "",
        "/repos/r/sub:",
        "b",
        "deep",
        "x3",
        "",
        "/repos/r/sub/deep:",
        "c",
        "x4",
      ),
      stderr: "",
      exitCode: 0,
    });
  });

  const counted: [string, string][] = [
    ["find /repos/r | wc -l", "12\n"],
    ["du /repos/r | wc -l", "3\n"],
    ["rg -l x /repos/r | wc -l", "4\n"],
    ["rg -L -l x /repos/r | wc -l", "8\n"],
    [
      "cp -r /repos/r /tmp/c && find /tmp/c | wc -l && readlink /tmp/c/a",
      "12\n.\n",
    ],
    ["tar -cf /tmp/a.tar /repos/r && tar -tf /tmp/a.tar | wc -l", "12\n"],
    ["shopt -s globstar; echo /repos/r/**/x*", `${files.join(" ")}\n`],
  ];
  for (const [script, stdout] of counted)
    test(`walks each entry once: ${script}`, async () => {
      expect(await shell().exec(script)).toMatchObject({
        stdout,
        stderr: "",
        exitCode: 0,
      });
    });
});
