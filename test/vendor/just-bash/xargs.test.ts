// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the recorded GNU xargs fixture cannot pin: stderr, which it does
// not compare, commands run at once, which it sees only sorted, and the
// sandbox's own bounds. The -t lines are GNU xargs 4.11.0's.

import { describe, expect, test } from "bun:test";
import { Bash, type SecureFetch } from "just-bash";

async function run(command: string, files: Record<string, string> = {}) {
  const bash = new Bash({ files, cwd: "/work" });
  return bash.exec(command);
}

describe("xargs -t", () => {
  test("prints plain words bare", async () => {
    const result = await run("printf 'a b\\n' | xargs -t echo x");
    expect(result.stderr).toBe("echo x a b\n");
  });

  test("quotes words the shell would read otherwise", async () => {
    const result = await run(
      `printf 'x\\n' | xargs -t echo "it's \\$x" 'a b' "it's" 'q"q' 'a\\b' '' '~x' 'x~' '#x' 'a#' 'a=b' '*' '{' '{}' é a,b a:b`,
    );
    expect(result.stderr).toBe(
      `echo 'it'\\''s $x' 'a b' "it's" 'q"q' 'a\\b' '' '~x' x~ '#x' a# 'a=b' '*' '{' {} é a,b a:b x\n`,
    );
  });

  test("writes a control character outside the quotes", async () => {
    const result = await run(
      'printf \'x\\n\' | xargs -t echo "$(printf \'a\\tb\')" "$(printf \'\\001a\')" "$(printf "a\\t\'b")"',
    );
    expect(result.stderr).toBe(
      "echo 'a'$'\\t''b' ''$'\\001''a' 'a'$'\\t'\\''b' x\n",
    );
  });

  test("prints what -0 read", async () => {
    const result = await run("printf '1\\n2\\n' | xargs -0 -t");
    expect(result.stderr).toBe("echo '1'$'\\n''2'$'\\n'\n");
  });

  test("prints the line -I built", async () => {
    const result = await run("printf 'x\\n' | xargs -t -I{} echo 'a b {}'");
    expect(result.stderr).toBe("echo 'a b x'\n");
  });
});

describe("xargs -P", () => {
  test("runs commands at once and keeps their output in input order", async () => {
    const bash = new Bash({ cwd: "/work" });
    const started = performance.now();
    const result = await bash.exec(
      "printf '1\\n2\\n3\\n4\\n' | xargs -P 4 -n1 sh -c 'sleep 0.2; echo $0'",
    );
    expect(result.stdout).toBe("1\n2\n3\n4\n");
    expect(performance.now() - started).toBeLessThan(700);
  });

  test("caps -P at 16", async () => {
    let running = 0;
    let peak = 0;
    const fetch: SecureFetch = async (url) => {
      running++;
      peak = Math.max(peak, running);
      await Bun.sleep(20);
      running--;
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        body: new TextEncoder().encode(url),
        url,
      };
    };
    const bash = new Bash({ cwd: "/work", fetch });
    const result = await bash.exec(
      "seq 40 | xargs -P 0 -I{} curl -sS -o /dev/null http://files.test/{}",
    );
    expect(result.exitCode).toBe(0);
    expect(peak).toBe(16);
  });

  test("gives each running command its own slot", async () => {
    const result = await run(
      "printf 'a\\nb\\nc\\nd\\n' | xargs -P2 -n1 --process-slot-var=SLOT sh -c 'echo $SLOT; sleep 0.1'",
    );
    expect(result.stdout.split("\n").sort().join(" ")).toBe(" 0 0 1 1");
  });

  // the staging chat that fetched a repository's files, 12 at a time
  test("fetches 51 files 12 at a time", async () => {
    let running = 0;
    let peak = 0;
    const fetch: SecureFetch = async (url) => {
      running++;
      peak = Math.max(peak, running);
      await Bun.sleep(40);
      running--;
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        body: new TextEncoder().encode(`body of ${url}\n`),
        url,
      };
    };
    const names = Array.from(
      { length: 51 },
      (_, i) => `src/dir${i % 5}/file ${i}.ts`,
    );
    const bash = new Bash({
      cwd: "/work",
      fetch,
      files: { "/work/dl2.txt": `${names.join("\n")}\n` },
    });
    const started = performance.now();
    const result = await bash.exec(
      `cat dl2.txt | xargs -P 12 -I{} sh -c 'mkdir -p "1ctx/$(dirname "{}")"; curl -sS "http://files.test/{}" -o "1ctx/{}"'`,
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(peak).toBe(12);
    // five rounds of 40 ms, where one at a time takes two seconds
    expect(performance.now() - started).toBeLessThan(1500);
    for (const name of names) {
      expect(await bash.fs.readFile(`/work/1ctx/${name}`)).toBe(
        `body of http://files.test/${name}\n`,
      );
    }
  });
});

describe("xargs --show-limits", () => {
  test("prints the sandbox's limits on stderr", async () => {
    const result = await run("xargs --show-limits -r echo < /dev/null");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Size of command buffer we are actually using: 131072\n",
    );
    expect(result.stderr).toContain(
      "Maximum parallelism (--max-procs must be no greater): 16\n",
    );
  });
});

describe("xargs's words", () => {
  const cases: [string, string, number][] = [
    [
      "printf 'x\\ny\\n' | xargs -n1 sh -c 'exit 255'",
      "xargs: sh: exited with status 255; aborting\n",
      124,
    ],
    [
      "printf 'x\\ny\\n' | xargs -n1 nosuchcmd",
      "xargs: failed to run command ‘nosuchcmd’: No such file or directory\n",
      127,
    ],
    [
      "printf 'x\\n' | xargs ./plain.txt",
      "xargs: failed to run command ‘./plain.txt’: Permission denied\n",
      126,
    ],
    [
      'printf "a \'b\\n" | xargs echo',
      "a\nxargs: unmatched single quote; by default quotes are special to xargs unless you use the -0 option\n",
      1,
    ],
    [
      "printf 'x\\n' | xargs -n nope echo",
      "xargs: invalid number \"nope\" for -n option\nTry 'xargs --help' for more information.\n",
      1,
    ],
    [
      "printf 'a bbbbbb\\n' | xargs -s 8 echo",
      "a\nxargs: argument line too long\n",
      1,
    ],
    [
      "printf 'a\\0b c\\n' | xargs -n1 echo 2>&1 >/dev/null",
      "xargs: WARNING: a NUL character occurred in the input.  It cannot be passed through in the argument list.  Did you mean to use the --null option?\n",
      0,
    ],
    [
      "printf '1 2\\n' | xargs -n1 -I{} echo {} 2>&1 >/dev/null",
      "xargs: warning: options --max-args and --replace/-I/-i are mutually exclusive, ignoring previous --max-args value\n",
      0,
    ],
    [
      "printf 'a b\\n' | xargs -p echo",
      "echo a b\nxargs: failed to open /dev/tty for reading: No such device or address\n",
      1,
    ],
    [
      "printf 'a b\\n' | xargs -o echo",
      "xargs: failed to open /dev/tty for reading: No such device or address\n",
      1,
    ],
  ];
  for (const [command, said, exitCode] of cases) {
    test(command, async () => {
      // the shell merges a command's stdout before its stderr, so a case
      // whose order matters keeps only stderr
      const merged = command.includes("2>&1") ? command : `${command} 2>&1`;
      const result = await run(merged, { "/work/plain.txt": "x" });
      expect(result.stdout).toBe(said);
      expect(result.exitCode).toBe(exitCode);
    });
  }

  test("-p and -o need no terminal when nothing runs", async () => {
    const result = await run("xargs -r -p -o echo < /dev/null");
    expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
  });
});
