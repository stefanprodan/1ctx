// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A repository on disk mounted read-only at /repos/r, as the command
// worker would mount one: a MountableFs over an InMemoryFs, an OverlayFs
// over the folder, the worker's commands and the defense-in-depth box on.
// Reads work, every write fails at the command with GNU's words, links
// and `..` stay inside the folder, a copy out works and a refused walk
// leaves nothing behind.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Bash,
  defineCommand,
  InMemoryFs,
  MountableFs,
  OverlayFs,
} from "just-bash";
import { KNOWLEDGE_COMMANDS } from "../../../src/server/bash/commands.ts";

// taken before any command runs: the box blocks the global during one
const hostSetTimeout = setTimeout;
const pause = (ms: number) =>
  new Promise<void>((resolve) => hostSetTimeout(resolve, ms));

let base = "";

// base/repo is the repository; base/secret.txt sits beside it, outside
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "overlay-mount-"));
  const repo = join(base, "repo");
  await mkdir(join(repo, "src/lib"), { recursive: true });
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(base, "secret.txt"), "secret\n");
  await writeFile(join(repo, "README.md"), "# repo\nhello\n");
  await writeFile(join(repo, "src/lib/a.ts"), "export const a = 1;\n");
  await writeFile(join(repo, "src/lib/b.ts"), "export const b = a;\n");
  await writeFile(join(repo, "docs/guide.md"), "guide\n");
  await writeFile(
    join(repo, "docs/big.bin"),
    Buffer.alloc(2 * 1024 * 1024, 97),
  );
  await writeFile(join(repo, "src/run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(repo, "src/run.sh"), 0o755);
  await symlink("lib/a.ts", join(repo, "src/link.ts"));
  await symlink(join(base, "secret.txt"), join(repo, "out.txt"));
  await symlink("../../secret.txt", join(repo, "src/up.txt"));
  for (let d = 0; d < 20; d++) {
    await mkdir(join(repo, `many/d${d}`), { recursive: true });
    for (let f = 0; f < 20; f++)
      await writeFile(join(repo, `many/d${d}/f${f}`), "");
  }
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

// a command that tries what the box blocks, and says what it got
const probe = defineCommand(
  "probe",
  async () => {
    try {
      new Function("return 1");
      return { stdout: "unblocked\n", stderr: "", exitCode: 0 };
    } catch (error) {
      const type = (error as { violation?: { type?: string } }).violation?.type;
      return { stdout: `${type ?? "error"}\n`, stderr: "", exitCode: 0 };
    }
  },
  { trusted: false },
);

function shell(executionLimits = {}) {
  const fs = new MountableFs({
    base: new InMemoryFs({}, { maxTotalBytes: 1024 * 1024 }),
  });
  fs.mkdirSync("/tmp", { recursive: true });
  fs.mount(
    "/repos/r",
    new OverlayFs({
      root: join(base, "repo"),
      mountPoint: "/",
      readOnly: true,
      allowSymlinks: true,
      maxFileReadSize: 1024 * 1024,
    }),
  );
  return new Bash({
    fs,
    cwd: "/tmp",
    commands: [...KNOWLEDGE_COMMANDS],
    customCommands: [probe],
    defenseInDepth: true,
    executionLimits,
  });
}

describe("a read-only repository mount", () => {
  const reads: [string, string][] = [
    ["cat /repos/r/README.md", "# repo\nhello\n"],
    ["wc -l /repos/r/src/lib/a.ts", "1 /repos/r/src/lib/a.ts\n"],
    ["rg -l 'const a' /repos/r/src", "/repos/r/src/lib/a.ts\n"],
    ["grep -rn hello /repos/r/README.md", "2:hello\n"],
    [
      "find /repos/r/src -type f | sort",
      "/repos/r/src/lib/a.ts\n/repos/r/src/lib/b.ts\n/repos/r/src/run.sh\n",
    ],
    ["du -s /repos/r/docs | cut -f2", "/repos/r/docs\n"],
    ["cat /repos/r/src/link.ts", "export const a = 1;\n"],
    ["cd /repos/r/src && cat lib/b.ts", "export const b = a;\n"],
  ];
  for (const [script, stdout] of reads)
    test(`reads: ${script}`, async () => {
      expect(await shell().exec(script)).toMatchObject({
        stdout,
        stderr: "",
        exitCode: 0,
      });
    });

  test("a file keeps its mode and a link its target", async () => {
    expect(
      await shell().exec(
        "[ -x /repos/r/src/run.sh ] && readlink /repos/r/src/link.ts",
      ),
    ).toMatchObject({ stdout: "lib/a.ts\n", stderr: "", exitCode: 0 });
  });

  const writes: [string, string, number][] = [
    ["echo x > /repos/r/f", "bash: /repos/r/f: Read-only file system\n", 1],
    [
      "echo x >> /repos/r/README.md",
      "bash: /repos/r/README.md: Read-only file system\n",
      1,
    ],
    [
      "echo x 1<> /repos/r/README.md",
      "bash: /repos/r/README.md: Read-only file system\n",
      1,
    ],
    ["cd /repos/r && echo x > f", "bash: f: Read-only file system\n", 1],
    [
      "rm /repos/r/README.md",
      "rm: cannot remove '/repos/r/README.md': Read-only file system\n",
      1,
    ],
    [
      "mkdir /repos/r/d",
      "mkdir: cannot create directory '/repos/r/d': Read-only file system\n",
      1,
    ],
    [
      "chmod 600 /repos/r/README.md",
      "chmod: changing permissions of '/repos/r/README.md': Read-only file system\n",
      1,
    ],
    [
      "touch /repos/r/README.md",
      "touch: cannot touch '/repos/r/README.md': Read-only file system\n",
      1,
    ],
    [
      "mv /repos/r/README.md /repos/r/R.md",
      "mv: cannot move '/repos/r/README.md' to '/repos/r/R.md': Read-only file system\n",
      1,
    ],
    [
      "cp /repos/r/README.md /repos/r/R.md",
      "cp: cannot create regular file '/repos/r/R.md': Read-only file system\n",
      1,
    ],
    [
      "ln -s a /repos/r/l",
      "ln: failed to create symbolic link '/repos/r/l': Read-only file system\n",
      1,
    ],
    [
      "ln /repos/r/README.md /repos/r/h",
      "ln: failed to create hard link '/repos/r/h' => '/repos/r/README.md': Read-only file system\n",
      1,
    ],
    [
      "sed -i s/hello/bye/ /repos/r/README.md",
      "sed: couldn't open temporary file /repos/r/sedXXXXXX: Read-only file system\n",
      4,
    ],
    [
      "echo x | tee /repos/r/f >/dev/null",
      "tee: /repos/r/f: Read-only file system\n",
      1,
    ],
    [
      "echo x > /repos/r/README.md/y",
      "bash: /repos/r/README.md/y: Not a directory\n",
      1,
    ],
    [
      "echo x > /repos/r/nope/y",
      "bash: /repos/r/nope/y: No such file or directory\n",
      1,
    ],
    [
      "mkdir -p /repos/r/README.md/x",
      "mkdir: cannot create directory '/repos/r/README.md/x': Not a directory\n",
      1,
    ],
    ["cat 0<> /repos/r/docs", "bash: /repos/r/docs: Is a directory\n", 1],
    [
      "awk 'BEGIN { print 1 > \"/repos/r/docs\" }'",
      "awk: cannot redirect to `/repos/r/docs': Is a directory\n",
      2,
    ],
    [
      "cp -r /repos/r/docs /repos/r/d2",
      "cp: cannot create directory '/repos/r/d2': Read-only file system\n",
      1,
    ],
    [
      "mv /repos/r /tmp/r",
      "mv: cannot move '/repos/r' to '/tmp/r': Device or resource busy\n",
      1,
    ],
    [
      "sed -n 'w /repos/r/out' /repos/r/README.md",
      "sed: couldn't open file /repos/r/out: Read-only file system\n",
      4,
    ],
  ];
  for (const [script, stderr, exitCode] of writes)
    test(`refuses: ${script}`, async () => {
      expect(await shell().exec(script)).toMatchObject({
        stdout: "",
        stderr,
        exitCode,
      });
    });

  test("a refused write leaves the file as it was", async () => {
    const bash = shell();
    await bash.exec("echo x > /repos/r/README.md; sed -i d /repos/r/README.md");
    expect((await bash.exec("cat /repos/r/README.md")).stdout).toBe(
      "# repo\nhello\n",
    );
  });

  const outside: string[] = [
    "cat /repos/r/out.txt",
    "cat /repos/r/src/up.txt",
    "cat /repos/r/../../secret.txt",
    "cd /repos/r && cat ../../secret.txt",
  ];
  for (const script of outside)
    test(`stays inside the folder: ${script}`, async () => {
      const result = await shell().exec(script);
      expect(result.stdout).toBe("");
      expect(result.stderr).toEndWith("No such file or directory\n");
      expect(result.exitCode).toBe(1);
    });

  const big = "/repos/r/docs/big.bin";
  const tooLarge: [string, string, number][] = [
    [`cat ${big}`, `cat: ${big}: File too large\n`, 1],
    [`head -c 3 ${big}`, `head: ${big}: File too large\n`, 1],
    [`wc -c < ${big}`, `bash: ${big}: File too large\n`, 1],
    [`sed -n 1p ${big}`, `sed: ${big}: File too large\n`, 1],
    [
      `awk 'END { print NR }' ${big}`,
      `awk: fatal: cannot open file '${big}' for reading: File too large\n`,
      2,
    ],
    [`jq . ${big}`, `jq: ${big}: File too large\n`, 2],
    [`grep -c a ${big}`, `grep: ${big}: File too large\n`, 2],
    [`rg -c a ${big}`, `rg: ${big}: File too large (os error 27)\n`, 2],
    [
      `cp ${big} /tmp/b`,
      `cp: cannot open '${big}' for reading: File too large\n`,
      1,
    ],
    [
      "cd /repos/r && cp -r docs /tmp/d",
      "cp: cannot open 'docs/big.bin' for reading: File too large\n",
      1,
    ],
    [
      "tar -cf /tmp/a.tar -C /repos/r docs",
      "tar: docs/big.bin: Cannot open: File too large\n",
      2,
    ],
  ];
  // md5sum says it on stdout, as upstream's own test holds
  test("a file over the read limit: md5sum", async () => {
    expect(await shell().exec(`md5sum ${big}`)).toMatchObject({
      stdout: `md5sum: ${big}: File too large\n`,
      stderr: "",
      exitCode: 1,
    });
  });
  for (const [script, stderr, exitCode] of tooLarge)
    test(`a file over the read limit: ${script}`, async () => {
      expect(await shell().exec(script)).toMatchObject({
        stdout: "",
        stderr,
        exitCode,
      });
    });

  test("cp copies out of the mount", async () => {
    expect(
      await shell().exec(
        "cp -r /repos/r/src /tmp/src && cat /tmp/src/lib/a.ts",
      ),
    ).toMatchObject({
      stdout: "export const a = 1;\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("mv out leaves the copy and says the source stays", async () => {
    const bash = shell();
    expect(await bash.exec("mv /repos/r/docs/guide.md /tmp/g")).toMatchObject({
      stdout: "",
      stderr:
        "mv: cannot remove '/repos/r/docs/guide.md': Read-only file system\n",
      exitCode: 1,
    });
    expect(await bash.exec("cat /tmp/g /repos/r/docs/guide.md")).toMatchObject({
      stdout: "guide\nguide\n",
      exitCode: 0,
    });
  });

  // fails without find-batch: the find's batch of directory reads on disk
  // outlives the command
  test.serial("a refused walk leaves no rejection behind", async () => {
    const unhandled: unknown[] = [];
    const record: NodeJS.UnhandledRejectionListener = (reason) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      const bash = shell({ maxTraversalEntries: 100 });
      for (const script of ["find /repos/r", "du /repos/r", "rg x /repos/r"])
        expect((await bash.exec(script)).exitCode).toBe(126);
      await pause(100);
    } finally {
      // bun-types type off() for "memoryPressure" alone
      (process as NodeJS.EventEmitter).off("unhandledRejection", record);
    }
    expect(unhandled).toEqual([]);
  });

  test.serial("the box stays on after the reads", async () => {
    expect(
      await shell().exec(
        "cat /repos/r/README.md >/tmp/x && find /repos/r/src >/tmp/y && probe",
      ),
    ).toMatchObject({
      stdout: "function_constructor\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
