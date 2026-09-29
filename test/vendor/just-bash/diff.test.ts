// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// diff's answers the recorded GNU fixture cannot hold: refusals whose GNU
// output depends on the clock or a terminal, bytes written through a
// redirect, and a directory standing for its namesake.

import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";

function shell(files: Record<string, string | Uint8Array>) {
  const fs = new InMemoryFs({}, {});
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(`/w/${name}`, content);
  }
  return { fs, bash: new Bash({ fs, cwd: "/w" }) };
}

describe("diff", () => {
  test("refuses -l, which needs pr, with exit 2", async () => {
    const { bash } = shell({ a: "a\n", b: "b\n" });
    for (const option of ["-l", "--paginate"]) {
      const result = await bash.exec(`diff ${option} a b`);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("pr");
    }
  });

  test("writes the files' own bytes through a redirect", async () => {
    const { fs, bash } = shell({
      a: new Uint8Array([0x63, 0xe9, 0x0a]),
      b: new Uint8Array([0x63, 0xe8, 0x0a]),
    });
    const result = await bash.exec("diff a b > out; echo $?");
    expect(result.stdout).toBe("1\n");
    const out = await fs.readFileBuffer("/w/out");
    expect([...out]).toEqual([
      ...new TextEncoder().encode("1c1\n< c"),
      0xe9,
      ...new TextEncoder().encode("\n---\n> c"),
      0xe8,
      0x0a,
    ]);
  });

  test("compares a file with its namesake in a directory", async () => {
    const { bash } = shell({ a: "x\n", "d/a": "y\n" });
    const forward = await bash.exec("diff a d");
    expect(forward.stdout).toBe("1c1\n< x\n---\n> y\n");
    expect(forward.exitCode).toBe(1);
    const backward = await bash.exec("diff d/ a");
    expect(backward.stdout).toBe("1c1\n< y\n---\n> x\n");
  });

  test("names each file as the shell would quote it", async () => {
    const { bash } = shell({ "a b": "x\n", c: "y\n" });
    const result = await bash.exec("diff -q 'a b' c");
    expect(result.stdout).toBe("Files 'a b' and c differ\n");
  });
});
