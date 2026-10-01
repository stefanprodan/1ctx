// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// mktemp and yes answer their version flag and `--` as GNU coreutils 9.11
// answered; mktemp's exclusive create keeps a directory's children; yes
// ends under a reader and an output cap without spinning.

import { describe, expect, test } from "bun:test";
import { Bash, defineCommand, InMemoryFs } from "just-bash";

const version = (name: string) =>
  `${name} (GNU coreutils) 9.11 (just-bash, compatible)\n` +
  `A sandboxed ${name} that follows GNU coreutils 9.11; see ${name} --help.\n`;

describe("version flag", () => {
  const answers = [
    "mktemp --version",
    "mktemp -p /w --version",
    "mktemp -p /w x.XXX --version",
    "mktemp --version --help",
    "mktemp -V",
    "mktemp -dV",
    "mktemp -qV x.XXX",
    "mktemp -dVp",
    "mktemp -V --bad",
    "mktemp x.XXX -V",
  ];
  for (const command of answers) {
    test(command, async () => {
      const bash = new Bash({ files: { "/w/.keep": "" } });
      const result = await bash.exec(command);
      expect(result.stdout).toBe(version("mktemp"));
      expect(result.exitCode).toBe(0);
    });
  }

  for (const command of ["yes --version", "yes a --version"]) {
    test(command, async () => {
      const result = await new Bash().exec(command);
      expect(result.stdout).toBe(version("yes"));
      expect(result.exitCode).toBe(0);
    });
  }

  test("refuses an attached value, as gyes does", async () => {
    const bash = new Bash();
    for (const flag of ["--version=x", "--help=x"]) {
      const result = await bash.exec(`yes a ${flag}`);
      const name = flag.slice(0, flag.indexOf("="));
      expect(result.stderr).toBe(
        `yes: option '${name}' doesn't allow an argument\n`,
      );
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(1);
    }
    const bad = await bash.exec("yes -x --version=x");
    expect(bad.stderr).toContain("invalid option -- 'x'");
  });

  test("is not reached after a bad option or as a value", async () => {
    const bash = new Bash({ files: { "/w/.keep": "" } });
    const bad = await bash.exec("mktemp --bad --version");
    expect(bad.stderr).toContain("unrecognized option '--bad'");
    expect(bad.exitCode).toBe(1);
    const value = await bash.exec("mktemp -p --version");
    expect(value.stderr).toContain("No such file or directory");
    expect(value.exitCode).toBe(1);
    const short = await bash.exec("mktemp -x -V");
    expect(short.stderr).toContain("invalid option -- 'x'");
    expect(short.exitCode).toBe(1);
    for (const command of ["mktemp -p -V", "mktemp -pV"]) {
      const taken = await bash.exec(command);
      expect(taken.stderr).toContain("No such file or directory");
      expect(taken.exitCode).toBe(1);
    }
    const ended = await bash.exec("mktemp -p /w -- -V");
    expect(ended.stderr).toBe("mktemp: too few X's in template '-V'\n");
    expect(ended.exitCode).toBe(1);
    const yes = await bash.exec("yes -x --version");
    expect(yes.stderr).toContain("invalid option -- 'x'");
    expect(yes.exitCode).toBe(1);
  });
});

describe("end of options", () => {
  test("yes prints what follows --", async () => {
    const bash = new Bash();
    expect((await bash.exec("yes -- -x | head -n 2")).stdout).toBe("-x\n-x\n");
    expect((await bash.exec("yes -- --version | head -n 1")).stdout).toBe(
      "--version\n",
    );
    expect((await bash.exec("yes -- | head -n 1")).stdout).toBe("y\n");
  });

  test("mktemp takes a template starting with -", async () => {
    const bash = new Bash({ files: { "/w/.keep": "" } });
    const file = await bash.exec("mktemp -p /w -- -x.XXX");
    expect(file.stdout).toMatch(/^\/w\/-x\.[0-9A-Za-z]{3}\n$/);
    const dir = await bash.exec("mktemp -d -p /w -- dXXX");
    expect(dir.stdout).toMatch(/^\/w\/d[0-9A-Za-z]{3}\n$/);
    const listed = await bash.exec("ls -a /w");
    expect(listed.stdout.split("\n")).toContain(file.stdout.slice(3, -1));
    expect(listed.stdout.split("\n")).toContain(dir.stdout.slice(3, -1));
  });

  test("mktemp reads --version after -- as a template", async () => {
    const bash = new Bash({ files: { "/w/.keep": "" } });
    const two = await bash.exec("mktemp -p /w -- x.XXX --version");
    expect(two.stderr).toBe("mktemp: too many templates\n");
    expect(two.exitCode).toBe(1);
    const few = await bash.exec("mktemp -p /w -- -d");
    expect(few.stderr).toBe("mktemp: too few X's in template '-d'\n");
    expect(few.exitCode).toBe(1);
  });
});

describe("createExclusive on InMemoryFs", () => {
  test("creates once, then EEXIST", async () => {
    const fs = new InMemoryFs({ "/w/.keep": "" });
    await fs.createExclusive("/w/a", { mode: 0o600 });
    expect((await fs.stat("/w/a")).mode & 0o777).toBe(0o600);
    await expect(fs.createExclusive("/w/a", { mode: 0o600 })).rejects.toThrow(
      /^EEXIST/,
    );
    await fs.createExclusive("/w/d", { mode: 0o700, directory: true });
    await expect(
      fs.createExclusive("/w/d", { mode: 0o700, directory: true }),
    ).rejects.toThrow(/^EEXIST/);
    await expect(fs.createExclusive("/w/d", { mode: 0o600 })).rejects.toThrow(
      /^EEXIST/,
    );
  });

  test("the parent lists what it made", async () => {
    const fs = new InMemoryFs({ "/w/.keep": "" });
    await fs.createExclusive("/w/a", { mode: 0o600 });
    await fs.createExclusive("/w/d", { mode: 0o700, directory: true });
    await fs.createExclusive("/w/d/b", { mode: 0o600 });
    expect((await fs.readdir("/w")).sort()).toEqual([".keep", "a", "d"]);
    expect(await fs.readdir("/w/d")).toEqual(["b"]);
    const bash = new Bash({ fs });
    expect((await bash.exec("ls -A /w")).stdout).toBe(".keep\na\nd\n");
    expect((await bash.exec("find /w | sort")).stdout).toBe(
      "/w\n/w/.keep\n/w/a\n/w/d\n/w/d/b\n",
    );
    expect((await bash.exec("rm -r /w/d && ls -A /w")).stdout).toBe(
      ".keep\na\n",
    );
  });

  test("through a linked folder, the real folder lists it", async () => {
    const fs = new InMemoryFs({ "/w/.keep": "" });
    await fs.symlink("/w", "/l");
    await fs.createExclusive("/l/a", { mode: 0o600 });
    expect((await fs.readdir("/w")).sort()).toEqual([".keep", "a"]);
    await expect(fs.createExclusive("/w/a", { mode: 0o600 })).rejects.toThrow(
      /^EEXIST/,
    );
  });

  test("a link in the name's place is taken, never followed", async () => {
    const fs = new InMemoryFs({ "/w/.keep": "" });
    await fs.symlink("/w/missing", "/w/a");
    await expect(fs.createExclusive("/w/a", { mode: 0o600 })).rejects.toThrow(
      /^EEXIST/,
    );
    expect(await fs.exists("/w/missing")).toBe(false);
  });

  test("calls in one tick have one winner", async () => {
    const fs = new InMemoryFs({ "/w/.keep": "" });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        fs.createExclusive("/w/a", {
          mode: 0o600,
          directory: index % 2 === 1,
        }),
      ),
    );
    const won = results.filter((result) => result.status === "fulfilled");
    expect(won).toHaveLength(1);
    expect(await fs.readdir("/w")).toEqual([".keep", "a"]);
  });

  test("concurrent mktemp calls get distinct names", async () => {
    const bash = new Bash({ files: { "/w/.keep": "" } });
    const runs = await Promise.all(
      Array.from({ length: 20 }, () => bash.exec("mktemp -p /w x.XXX")),
    );
    const names = runs.map((run) => run.stdout.trim());
    expect(new Set(names).size).toBe(20);
    const listed = await bash.exec("ls /w | wc -l");
    expect(listed.stdout.trim()).toBe("20");
  });
});

describe("yes ends", () => {
  test("under head", async () => {
    const result = await new Bash().exec("yes | head -n 3");
    expect(result.stdout).toBe("y\ny\ny\n");
    expect(result.exitCode).toBe(0);
  });

  test("at the iteration cap", async () => {
    const bash = new Bash({ executionLimits: { maxLoopIterations: 5 } });
    expect((await bash.exec("yes")).stdout).toBe("y\ny\ny\ny\ny\n");
  });

  test("under a small output cap", async () => {
    const bash = new Bash({ executionLimits: { maxOutputSize: 64 } });
    const result = await bash.exec("yes ab | wc -l");
    expect(result.stdout.trim()).toBe("21");
    const one = await bash.exec("yes $(printf '%0100d' 0)");
    expect(one.exitCode).not.toBe(0);
    expect(one.stdout).toBe("");
  });

  test("a cancel stops a loop of it", async () => {
    const controller = new AbortController();
    let calls = 0;
    // cancels on its third call, so the loop is stopped mid-run, never
    // before it starts, and the cap bounds a miss
    const trip = defineCommand("trip", async () => {
      if (++calls === 3) controller.abort();
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const bash = new Bash({
      files: { "/w/.keep": "" },
      customCommands: [trip],
      executionLimits: { maxLoopIterations: 200 },
    });
    const result = await bash.exec(
      "while true; do yes | head -n 1 >> /w/runs; trip; done",
      { signal: controller.signal },
    );
    expect(result.exitCode).toBe(124);
    expect(calls).toBe(3);
    expect(await bash.fs.readFile("/w/runs")).toBe("y\ny\ny\n");
  });
});
