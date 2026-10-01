// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// OverlayFs reads the disk under the defense-in-depth box, as every bash
// command runs: each disk call runs trusted, and a command after the read
// stays blocked.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bash, defineCommand, OverlayFs } from "just-bash";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "overlay-trusted-"));
  await mkdir(join(root, "src/lib"), { recursive: true });
  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await writeFile(join(root, "src/lib/a.ts"), "export const a = 1;\n");
  await symlink("lib/a.ts", join(root, "src/link.ts"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
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

function shell() {
  return new Bash({
    fs: new OverlayFs({
      root,
      mountPoint: "/",
      readOnly: true,
      allowSymlinks: true,
    }),
    cwd: "/",
    customCommands: [probe],
    defenseInDepth: true,
  });
}

describe("OverlayFs under the defense-in-depth box", () => {
  const cases: [string, string][] = [
    ["cat /README.md", "hello\nworld\n"],
    ["wc -l < /README.md", "2\n"],
    ["cat /src/link.ts", "export const a = 1;\n"],
    ["ls /src", "lib\nlink.ts\n"],
    ["find /src -type f", "/src/lib/a.ts\n"],
    ["rg -l const /src/lib", "/src/lib/a.ts\n"],
    ["grep -r world /", "/README.md:world\n"],
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
});
