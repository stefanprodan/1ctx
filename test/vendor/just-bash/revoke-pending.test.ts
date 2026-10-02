// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command stopped while a call it made is still pending, a read of a
// lazily loaded file, ends inside the cleanup grace: timeout answers 124
// and the script goes on, as bash's does, where it used to end it whole.

import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";

function shell(delayMs: number, defenseInDepth: boolean) {
  const fs = new InMemoryFs();
  fs.writeFileLazy(
    "/f",
    () =>
      new Promise((resolve) => setTimeout(() => resolve("data\n"), delayMs)),
  );
  return new Bash({ fs, cwd: "/", defenseInDepth });
}

describe("a stopped command's pending call", () => {
  for (const defenseInDepth of [false, true]) {
    test(`timeout over a slow lazy read ends the read alone (box ${defenseInDepth})`, async () => {
      const bash = shell(300, defenseInDepth);
      const result = await bash.exec(
        "timeout 0.01 cat /f; echo after $?; cat /f",
      );
      expect(result).toMatchObject({
        stdout: "after 124\ndata\n",
        stderr: "",
        exitCode: 0,
      });
    });
  }

  test("a read that lands before the timeout is kept", async () => {
    const bash = shell(5, true);
    const result = await bash.exec("timeout 5 cat /f");
    expect(result).toMatchObject({ stdout: "data\n", exitCode: 0 });
  });
});
