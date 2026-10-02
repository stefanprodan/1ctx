// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// OverlayFs reads the disk under the defense-in-depth box, as every bash
// command runs: a file is read through a descriptor, nothing runs trusted,
// so the box stays on while a read is in flight, and a file swapped for a
// link after the path check is not followed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bash, defineCommand, OverlayFs } from "just-bash";

let base = "";
let root = "";

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "overlay-read-"));
  root = join(base, "repo");
  await mkdir(join(root, "src/lib"), { recursive: true });
  await writeFile(join(base, "secret.txt"), "secret\n");
  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await writeFile(join(root, "src/lib/a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "swap.txt"), "plain\n");
  await writeFile(join(root, "big"), Buffer.alloc(4 * 1024 * 1024, 97));
  await symlink("lib/a.ts", join(root, "src/link.ts"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const blocked = () => {
  try {
    new Function("return 1");
    return "unblocked";
  } catch (error) {
    return (
      (error as { violation?: { type?: string } }).violation?.type ?? "error"
    );
  }
};

// a command that tries what the box blocks, and says what it got
const probe = defineCommand(
  "probe",
  async () => {
    return { stdout: `${blocked()}\n`, stderr: "", exitCode: 0 };
  },
  { trusted: false },
);

// tries the box while a read of the disk it started is still in flight
const during = defineCommand(
  "during",
  async (args, ctx) => {
    const pending =
      args[0] === "read" ? ctx.fs.readFile("/big") : ctx.fs.readdir("/src/lib");
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await null;
      seen.push(blocked());
    }
    await pending;
    seen.push(blocked());
    return { stdout: `${seen.join(" ")}\n`, stderr: "", exitCode: 0 };
  },
  { trusted: false },
);

function shell() {
  return new Bash({
    fs: new OverlayFs({
      root,
      mountPoint: "/",
      readOnly: true,
      allowSymlinks: true,
      maxFileReadSize: 8 * 1024 * 1024,
    }),
    cwd: "/",
    customCommands: [probe, during],
    defenseInDepth: true,
  });
}

describe("OverlayFs under the defense-in-depth box", () => {
  const cases: [string, string][] = [
    ["cat /README.md", "hello\nworld\n"],
    ["wc -l < /README.md", "2\n"],
    ["cat /src/link.ts", "export const a = 1;\n"],
    ["wc -c < /big", "4194304\n"],
    ["ls /src", "lib\nlink.ts\n"],
    ["find /src -type f", "/src/lib/a.ts\n"],
    ["rg -l const /src/lib", "/src/lib/a.ts\n"],
    ["grep -r world /README.md", "world\n"],
    // (1ctx stat-mode ls-long) the permission bits, not the disk's whole mode
    ["stat -c %a /README.md /src", "644\n755\n"],
    ["ls -l /README.md | cut -c1-10", "-rw-r--r--\n"],
    ["ls -l /src | cut -c1-10", "total 2\ndrwxr-xr-x\nlrwxrwxrwx\n"],
  ];
  for (const [script, stdout] of cases)
    test.serial(`reads the disk: ${script}`, async () => {
      expect(await shell().exec(script)).toMatchObject({
        stdout,
        stderr: "",
        exitCode: 0,
      });
    });

  test.serial("a command after a read stays blocked", async () => {
    expect(await shell().exec("cat /README.md && probe")).toMatchObject({
      stdout: "hello\nworld\nfunction_constructor\n",
      stderr: "",
      exitCode: 0,
    });
  });

  for (const kind of ["read", "readdir"])
    test.serial(`the box stays on while a ${kind} is in flight`, async () => {
      const blockedAll = Array(4).fill("function_constructor").join(" ");
      expect(await shell().exec(`during ${kind}`)).toMatchObject({
        stdout: `${blockedAll}\n`,
        stderr: "",
        exitCode: 0,
      });
    });

  test.serial(
    "a file swapped for a link after the check is not followed",
    async () => {
      const swapped = join(root, "swap.txt");
      const promises = nodeFs.promises as {
        lstat: typeof nodeFs.promises.lstat;
      };
      const lstat = promises.lstat;
      // the swap lands between the path check (lstat) and the open
      promises.lstat = (async (path: nodeFs.PathLike) => {
        const stat = await lstat(path);
        if (String(path).endsWith("swap.txt")) {
          await unlink(swapped);
          await symlink(join(base, "secret.txt"), swapped);
        }
        return stat;
      }) as typeof lstat;
      try {
        expect(await shell().exec("cat /swap.txt")).toMatchObject({
          stdout: "",
          stderr: "cat: /swap.txt: No such file or directory\n",
          exitCode: 1,
        });
      } finally {
        promises.lstat = lstat;
      }
    },
  );
});
