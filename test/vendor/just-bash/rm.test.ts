// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// rm walks a tree one entry at a time under the command's traversal
// budget and its cancellation, and -f forgives a missing file only, as
// GNU coreutils 9.11 rm does.

import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";

const tree =
  "mkdir -p /d/e; for i in 1 2 3 4 5 6; do touch /d/f$i /d/e/g$i; done";

// a backend that refuses every removal, as a read-only mount does
class ReadOnlyFs extends InMemoryFs {
  override async rm(path: string): Promise<void> {
    throw new Error(`EROFS: read-only file system, rm '${path}'`);
  }
}

// a backend that cancels the command at its first removal
class CancellingFs extends InMemoryFs {
  removed = 0;
  constructor(private readonly controller: AbortController) {
    super();
  }
  override async rm(
    path: string,
    options?: Parameters<InMemoryFs["rm"]>[1],
  ): Promise<void> {
    this.removed++;
    this.controller.abort();
    return super.rm(path, options);
  }
}

describe("rm", () => {
  test("a tree past the traversal budget stops the command", async () => {
    const bash = new Bash({
      cwd: "/",
      executionLimits: { maxTraversalEntries: 5 },
    });
    await bash.exec(tree);
    const result = await bash.exec("rm -rf /d");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("entry limit exceeded (5)");
    expect((await bash.exec("ls /d | wc -l")).stdout.trim()).not.toBe("0");
  });

  test("a cancelled command stops removing", async () => {
    const controller = new AbortController();
    const fs = new CancellingFs(controller);
    const bash = new Bash({ cwd: "/", fs });
    await bash.exec(tree);
    const result = await bash.exec("rm -rf /d", {
      signal: controller.signal,
    });
    expect(result.exitCode).not.toBe(0);
    expect(fs.removed).toBe(1);
    expect(await fs.exists("/d/e")).toBe(true);
  });

  test("-f keeps a read-only refusal", async () => {
    const bash = new Bash({ cwd: "/", fs: new ReadOnlyFs() });
    await bash.exec("mkdir -p /d/e; touch /x /d/y /d/e/z");
    expect(await bash.exec("rm -f /x /missing")).toMatchObject({
      stdout: "",
      stderr: "rm: cannot remove '/x': Read-only file system\n",
      exitCode: 1,
    });
    expect(await bash.exec("rm -rf /d")).toMatchObject({
      stdout: "",
      stderr:
        "rm: cannot remove '/d/e/z': Read-only file system\nrm: cannot remove '/d/y': Read-only file system\n",
      exitCode: 1,
    });
  });

  test("-f forgives a missing file and a file named as a folder", async () => {
    const bash = new Bash({ cwd: "/" });
    await bash.exec("touch /x");
    expect(await bash.exec("rm -f /missing /x/ /missing/y")).toMatchObject({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  test("-v names each entry a walk removes", async () => {
    const bash = new Bash({ cwd: "/" });
    await bash.exec("mkdir -p /d/e; touch /d/e/f");
    expect((await bash.exec("rm -rv /d")).stdout).toBe(
      "removed '/d/e/f'\nremoved directory '/d/e'\nremoved directory '/d'\n",
    );
  });
});
