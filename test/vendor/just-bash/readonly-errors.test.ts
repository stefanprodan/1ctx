// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A write into a read-only mount fails as bash and GNU coreutils answer:
// a redirect is `bash: <target>: Read-only file system` with exit 1 and
// the command not run, never a throw out of exec(); a command names the
// path as typed, never the mount's own.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Bash,
  defineCommand,
  InMemoryFs,
  MountableFs,
  OverlayFs,
} from "just-bash";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "readonly-errors-"));
  await mkdir(join(root, "d"));
  await writeFile(join(root, "f"), "hello\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// a command that writes where it is told, and lets the error through
const put = defineCommand("put", async (args, ctx) => {
  await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, args[0] ?? ""), "x");
  return { stdout: "", stderr: "", exitCode: 0 };
});

function shell() {
  const fs = new MountableFs({ base: new InMemoryFs() });
  fs.mount("/ro", new OverlayFs({ root, mountPoint: "/", readOnly: true }));
  return new Bash({ fs, cwd: "/tmp", customCommands: [put] });
}

const refused = (target: string) => ({
  stdout: "",
  stderr: `bash: ${target}: Read-only file system\n`,
  exitCode: 1,
});

describe("a redirect into a read-only mount", () => {
  const cases: [string, string][] = [
    ["touch /tmp/ran > /ro/new", "/ro/new"],
    ["touch /tmp/ran >> /ro/f", "/ro/f"],
    ["touch /tmp/ran >| /ro/f", "/ro/f"],
    ["touch /tmp/ran &> /ro/f", "/ro/f"],
    ["touch /tmp/ran &>> /ro/f", "/ro/f"],
    ["touch /tmp/ran 2> /ro/f", "/ro/f"],
    ["touch /tmp/ran 1<> /ro/f", "/ro/f"],
    ["touch /tmp/ran 3<> /ro/new", "/ro/new"],
    ["touch /tmp/ran >& /ro/f", "/ro/f"],
    ["{ touch /tmp/ran; } > /ro/f", "/ro/f"],
    ["cd /ro && touch /tmp/ran > f", "f"],
  ];
  for (const [script, target] of cases)
    test(`fails as bash does: ${script}`, async () => {
      const bash = shell();
      expect(await bash.exec(script)).toMatchObject(refused(target));
      expect(await bash.exec("ls /tmp")).toMatchObject({
        stdout: "",
        exitCode: 0,
      });
    });

  test("exec opening one fails and the script goes on", async () => {
    expect(await shell().exec("exec 3> /ro/f; echo on")).toMatchObject({
      stdout: "on\n",
      stderr: "bash: /ro/f: Read-only file system\n",
      exitCode: 0,
    });
  });

  test("a folder is still a folder", async () => {
    expect(await shell().exec("echo x > /ro/d")).toMatchObject({
      stderr: "bash: /ro/d: Is a directory\n",
      exitCode: 1,
    });
  });

  test("reading through one still works", async () => {
    expect(await shell().exec("cat < /ro/f")).toMatchObject({
      stdout: "hello\n",
      exitCode: 0,
    });
  });

  test("<> on a writable file writes at its start", async () => {
    expect(
      await shell().exec("echo hello > /tmp/f; echo HE 1<> /tmp/f; cat /tmp/f"),
    ).toMatchObject({ stdout: "HE\nlo\n", stderr: "", exitCode: 0 });
  });
});

describe("a command writing into a read-only mount", () => {
  test("one that lets the error through says the words only", async () => {
    expect(await shell().exec("put /ro/x")).toMatchObject({
      stdout: "",
      stderr: "put: Read-only file system\n",
      exitCode: 1,
    });
  });

  test("mkdir -p of a folder there succeeds", async () => {
    expect(await shell().exec("mkdir -p /ro/d")).toMatchObject({
      stderr: "",
      exitCode: 0,
    });
  });

  test("mkdir of a folder there says it exists", async () => {
    expect(await shell().exec("mkdir /ro/d")).toMatchObject({
      stderr: "mkdir: cannot create directory '/ro/d': File exists\n",
      exitCode: 1,
    });
  });

  test("mkdir under a missing folder says it is missing", async () => {
    expect(await shell().exec("mkdir /ro/x/y")).toMatchObject({
      stderr:
        "mkdir: cannot create directory '/ro/x/y': No such file or directory\n",
      exitCode: 1,
    });
  });
});
