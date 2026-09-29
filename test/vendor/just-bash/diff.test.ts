// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// diff's answers the recorded GNU fixture cannot hold: refusals whose GNU
// output depends on the clock or a terminal, bytes written through a
// redirect, a directory standing for its namesake, directory loops and the
// limits a walk of two trees is held to.

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

  test("looks for a NUL further into stdin, as GNU reads a pipe", async () => {
    const text = `${"x".repeat(30000)}\0\n`;
    const { bash } = shell({ f: text, other: "b\n" });
    const piped = await bash.exec("cat f | diff - other");
    expect(piped.stdout).toBe("Binary files - and other differ\n");
    const file = await bash.exec("diff f other | head -c 3");
    expect(file.stdout).toBe("1c1");
  });

  test("charges folding and matching to the work limit", async () => {
    const fs = new InMemoryFs({}, {});
    fs.writeFileSync("/w/a", `${"a".repeat(100000)}\n`);
    fs.writeFileSync("/w/b", `${"A".repeat(100000)}\n`);
    const bash = new Bash({
      fs,
      cwd: "/w",
      executionLimits: { maxLoopIterations: 1000 },
    });
    const plain = await bash.exec("diff a b > /dev/null; echo $?");
    expect(plain.stdout).toBe("1\n");
    const folded = await bash.exec("diff -i a b; echo $?");
    expect(folded.stdout).toBe("2\n");
    expect(folded.stderr).toContain("work limit exceeded");
  });

  test("sorts a directory's names by bytes in the C locale", async () => {
    const { bash } = shell({
      "d1/a": "1\n",
      "d1/B": "1\n",
      "d2/a": "2\n",
      "d2/B": "2\n",
    });
    const result = await bash.exec("diff -q d1 d2");
    expect(result.stdout).toBe(
      "Files d1/B and d2/B differ\nFiles d1/a and d2/a differ\n",
    );
    const collated = await bash.exec("LC_ALL=en_US.UTF-8 diff -q d1 d2");
    expect(collated.stdout).toBe(
      "Files d1/a and d2/a differ\nFiles d1/B and d2/B differ\n",
    );
  });

  test("stops at a directory that loops back on both sides", async () => {
    const { fs, bash } = shell({ "d1/f": "a\n", "d2/f": "b\n" });
    await fs.symlink(".", "/w/d1/self");
    await fs.symlink(".", "/w/d2/self");
    const result = await bash.exec("diff -r d1 d2");
    expect(result.stdout).toBe("diff -r d1/f d2/f\n1c1\n< a\n---\n> b\n");
    expect(result.stderr).toContain("d1/self: recursive directory loop");
    expect(result.exitCode).toBe(2);
  });

  test("charges every pair of a directory to one work limit", async () => {
    const lines = "x\n".repeat(60000);
    const fs = new InMemoryFs({}, {});
    for (const name of ["a", "b"]) {
      fs.writeFileSync(`/w/d1/${name}`, `${lines}1\n`);
      fs.writeFileSync(`/w/d2/${name}`, `${lines}2\n`);
    }
    const bash = new Bash({
      fs,
      cwd: "/w",
      executionLimits: { maxLoopIterations: 1000 },
    });
    const one = await bash.exec("diff d1/a d2/a > /dev/null; echo $?");
    expect(one.stdout).toBe("1\n");
    const tree = await bash.exec("diff -r d1 d2 > /dev/null; echo $?");
    expect(tree.stdout).toBe("2\n");
    expect(tree.stderr).toContain("work limit exceeded");
  });

  test("charges side by side padding and formats to the work limit", async () => {
    const { bash } = shell({ a: "a\n", b: "b\n", c: "a\n".repeat(5000) });
    const wide = await bash.exec("diff -y -W 1000000000 a b");
    expect(wide.exitCode).toBe(2);
    expect(wide.stderr).toContain("work limit exceeded");
    const format = "%L".repeat(20000);
    const long = await bash.exec(`diff --line-format='${format}' a c`);
    expect(long.exitCode).toBe(2);
    expect(long.stderr).toContain("work limit exceeded");
  });

  test("charges what a format writes, widths included", async () => {
    const { bash } = shell({ a: `${"x".repeat(1000000)}\n`, b: "y\n" });
    for (const command of [
      `diff --old-line-format='${"%L".repeat(2000)}' a b`,
      "diff --line-format='%2000000000dn' a b",
      "diff --old-group-format='%.300000000dF' a b",
    ]) {
      const result = await bash.exec(command);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("work limit exceeded");
    }
  });

  test("charges the spaces -t and -E expand tabs to", async () => {
    // tabs on both sides, since ed and RCS scripts print only the second
    const tabs = "\t".repeat(200);
    const { bash } = shell({ a: `${tabs}a\n`, b: `${tabs}b\n` });
    for (const style of ["", "-u", "-c", "-e", "-f", "-n", "-D X"]) {
      const result = await bash.exec(
        `diff -t --tabsize=100000000 ${style} a b`,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("work limit exceeded");
    }
    const folded = await bash.exec("diff -E --tabsize=100000000 a b");
    expect(folded.exitCode).toBe(2);
    expect(folded.stderr).toContain("work limit exceeded");
  });

  test("charges -x and -X matching to the work limit", async () => {
    const fs = new InMemoryFs({}, {});
    const long = "ab".repeat(500);
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(`/w/d1/${long}${i}`, "a\n");
      fs.writeFileSync(`/w/d2/${long}${i}`, "a\n");
    }
    const pattern = `${"*a*b".repeat(10)}*q`;
    fs.writeFileSync("/w/x", `${pattern}\n`.repeat(200));
    const bash = new Bash({
      fs,
      cwd: "/w",
      executionLimits: { maxLoopIterations: 1000 },
    });
    const result = await bash.exec("diff -r -X x d1 d2");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("work limit exceeded");
    const one = await bash.exec(`diff -r -x '${pattern}' d1 d2`);
    expect(one.exitCode).toBe(0);
  });

  test("lays out a width past 32 bits, failing on the padding", async () => {
    const { bash } = shell({ a: "a\n", b: "b\n" });
    const result = await bash.exec("diff -y -W 4294967336 a b");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("work limit exceeded");
  });

  test("names both files when neither exists under -N", async () => {
    const { bash } = shell({});
    const result = await bash.exec("diff -N nope1 nope2");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("nope1: No such file or directory");
    expect(result.stderr).toContain("nope2: No such file or directory");
  });

  test("walks directories within the traversal budget", async () => {
    const fs = new InMemoryFs({}, {});
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(`/w/d1/f${i}`, "a\n");
      fs.writeFileSync(`/w/d2/f${i}`, "a\n");
    }
    const bash = new Bash({
      fs,
      cwd: "/w",
      executionLimits: { maxTraversalEntries: 10 },
    });
    const result = await bash.exec("diff -r d1 d2");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("entry limit exceeded");
  });

  test("names each file as the shell would quote it", async () => {
    const { bash } = shell({ "a b": "x\n", c: "y\n" });
    const result = await bash.exec("diff -q 'a b' c");
    expect(result.stdout).toBe("Files 'a b' and c differ\n");
  });
});
