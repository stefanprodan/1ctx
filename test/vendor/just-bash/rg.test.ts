// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the recorded ripgrep fixture cannot pin: the words of a refusal,
// which the fixture does not compare, --version, whose lines name the
// recording machine, bytes that are not UTF-8, which the fixture's text
// cannot hold, and the time sorts, which need set modification times.

import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";

async function run(command: string, files: Record<string, string> = {}) {
  const bash = new Bash({ files, cwd: "/work" });
  return bash.exec(command);
}

describe("rg's words", () => {
  test("-P names what RE2 cannot run", async () => {
    const result = await run("rg -P '(ab)\\1' hay", { "/work/hay": "abab\n" });
    expect(result.stderr).toBe(
      "rg: backreference \\1 is not supported: the regex engine is RE2, which has no backreferences\n",
    );
    expect(result.exitCode).toBe(2);
  });

  test("an unknown type is ripgrep's error", async () => {
    const result = await run("rg -t nosuch x", { "/work/hay": "x\n" });
    expect(result.stderr).toBe("rg: unrecognized file type: nosuch\n");
    expect(result.exitCode).toBe(2);
  });

  test("--color=always is refused naming it", async () => {
    const result = await run("rg --color=always x hay", { "/work/hay": "x\n" });
    expect(result.stderr).toBe(
      "rg: error parsing flag --color: --color=always is not supported: output is always plain\n",
    );
    expect(result.exitCode).toBe(2);
  });

  test("-h prints the help, as ripgrep's short help", async () => {
    const result = await run("rg -h");
    expect(result.stdout).toStartWith("rg - recursively search");
    expect(result.exitCode).toBe(0);
  });

  test("--version says what ripgrep says first", async () => {
    const result = await run("rg --version");
    expect(result.stdout).toBe("ripgrep 15.2.0\n\nfeatures:+pcre2\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("rg on bytes and times", () => {
  test("a file that is not UTF-8 is text", async () => {
    const fs = new InMemoryFs({}, {});
    fs.writeFileSync(
      "/work/latin",
      new Uint8Array([0x63, 0xe9, 0x20, 0x78, 0x0a]),
    );
    const bash = new Bash({ fs, cwd: "/work" });
    const result = await bash.exec("rg x latin");
    expect(result.stdout).toMatch(/^c.+ x\n$/);
    expect(result.exitCode).toBe(0);
  });

  test("--sort and --sortr modified order by mtime", async () => {
    const fs = new InMemoryFs({}, {});
    for (const [name, day] of [
      ["a.txt", 3],
      ["b.txt", 1],
      ["c.txt", 2],
    ] as const) {
      fs.writeFileSync(`/work/${name}`, "x\n");
      await fs.utimes(`/work/${name}`, new Date(0), new Date(2026, 0, day));
    }
    const bash = new Bash({ fs, cwd: "/work" });
    const up = await bash.exec("rg --sort modified -l x");
    expect(up.stdout).toBe("b.txt\nc.txt\na.txt\n");
    const down = await bash.exec("rg --sortr accessed -l x");
    expect(down.stdout).toBe("a.txt\nc.txt\nb.txt\n");
  });
});

describe("rg's shortcuts keep its answers", () => {
  const files = {
    "/work/a.md": "# Crashloop\nrestart\n",
    "/work/b.md": "nothing here\n",
    "/work/c.md": "one\nCRASHLOOP twice crashloop\n",
  };
  const answer = async (command: string, hay: Record<string, string>) => {
    const r = await run(command, hay);
    return [r.stdout, r.stderr, r.exitCode];
  };

  test("-il, --files-without-match, -ic and -q answer as before", async () => {
    expect(await answer("rg -il --sort path crashloop", files)).toEqual([
      "a.md\nc.md\n",
      "",
      0,
    ]);
    expect(
      await answer("rg -i --files-without-match crashloop", files),
    ).toEqual(["b.md\n", "", 0]);
    expect(await answer("rg -ic --sort path crashloop", files)).toEqual([
      "a.md:1\nc.md:1\n",
      "",
      0,
    ]);
    expect(await answer("rg -qi crashloop", files)).toEqual(["", "", 0]);
    expect(await answer("rg -q zzz", files)).toEqual(["", "", 1]);
  });

  test("-i folds as the regex does, not as toLowerCase", async () => {
    const hay = { "/work/hay": "ſ\nΟΣ\nς\n" };
    expect(await answer("rg -i s hay", hay)).toEqual(["ſ\n", "", 0]);
    expect(await answer("rg -il s hay", hay)).toEqual(["hay\n", "", 0]);
    expect(await answer("rg -iv s hay", hay)).toEqual(["ΟΣ\nς\n", "", 0]);
    expect(await answer("rg -i σ hay", hay)).toEqual(["ΟΣ\nς\n", "", 0]);
  });

  test("-i folds ſ to s with the Kelvin sign, as ripgrep", async () => {
    const hay = { "/work/hay": "ſ\u212a\n" };
    expect(await answer("rg -i sk hay", hay)).toEqual(["ſ\u212a\n", "", 0]);
  });

  test("an escape is not the letter it names", async () => {
    const hay = { "/work/hay": "\u0007\na\n" };
    expect(await answer("rg '\\a' hay", hay)).toEqual(["\u0007\n", "", 0]);
  });

  test("--passthru with -c counts only files that match", async () => {
    expect(await answer("rg --passthru -c hit b.md", files)).toEqual([
      "",
      "",
      1,
    ]);
  });
});
