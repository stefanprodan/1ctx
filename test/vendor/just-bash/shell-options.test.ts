// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// bash and sh read their invocation options as GNU bash 5.3 does: the
// stdout, first stderr line and exit code bash 5.3.20 answered for the
// same commands over the same files.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

const files = {
  "/w/good.sh": "echo ok\n",
  "/w/bad.sh": "echo before\nif then\n",
  "/w/e.sh": "false\necho after\n",
  "/w/u.sh": "echo $undefined_x\necho after\n",
  "/w/x.sh": "echo hi\n",
  "/w/pf.sh": 'false | true\necho "rc=$?"\n',
  "/w/line.sh": "#!/bin/bash\necho $LINENO\n",
  "/w/args.sh": 'echo "args: $*"\n',
};

async function run(script: string) {
  const result = await new Bash({ files, cwd: "/w" }).exec(script);
  return {
    stdout: result.stdout,
    stderr: result.stderr.split("\n")[0],
    exitCode: result.exitCode,
  };
}

// [command, stdout, first stderr line, exit code]
const cases: [string, string, string, number][] = [
  ["bash -n good.sh", "", "", 0],
  ["bash -e e.sh", "", "", 1],
  ["bash e.sh", "after\n", "", 0],
  ["bash -x x.sh", "hi\n", "+ echo hi", 0],
  ["bash -v x.sh", "hi\n", "echo hi", 0],
  ["bash -eo pipefail pf.sh", "", "", 1],
  ["bash -o pipefail pf.sh", "rc=1\n", "", 0],
  ["bash -o pipefail +o pipefail pf.sh", "rc=0\n", "", 0],
  ["bash -oe pipefail pf.sh", "", "", 1],
  ["bash -e +e e.sh", "after\n", "", 0],
  ["bash -e -- e.sh", "", "", 1],
  ["bash -x -- x.sh a", "hi\n", "+ echo hi", 0],
  ["bash - x.sh", "hi\n", "", 0],
  ["bash -ec 'false; echo after'", "", "", 1],
  ["bash -xc 'echo hi'", "hi\n", "+ echo hi", 0],
  ["bash -c -e 'false; echo after'", "", "", 1],
  ["bash -euo pipefail -c 'false | true; echo $?'", "", "", 1],
  ["bash -co pipefail 'false | true; echo $?'", "1\n", "", 0],
  ["bash -ce 'echo $0' a", "a\n", "", 0],
  ["bash -n -c 'echo hi'", "", "", 0],
  ["bash -f -c 'echo *.sh'", "*.sh\n", "", 0],
  ["bash -a -c 'x=1; env | grep ^x='", "x=1\n", "", 0],
  ["bash -c ''", "", "", 0],
  ["bash -c", "", "bash: -c: option requires an argument", 2],
  ["bash -Q x.sh", "", "bash: -Q: invalid option", 2],
  ["bash +Q x.sh", "", "bash: +Q: invalid option", 2],
  ["bash --bogus x.sh", "", "bash: --bogus: invalid option", 2],
  [
    "bash -o badname x.sh",
    "",
    "bash: line 0: bash: badname: invalid option name",
    2,
  ],
  [
    "bash +o badname x.sh",
    "",
    "bash: line 0: bash: badname: invalid option name",
    2,
  ],
  ["bash -o -e x.sh", "", "bash: line 0: bash: -e: invalid option name", 2],
  ["bash --noprofile --norc -eo pipefail pf.sh", "", "", 1],
  ["bash --noprofile x.sh", "hi\n", "", 0],
  ["bash args.sh --help", "args: --help\n", "", 0],
  ["bash x.sh --norc", "hi\n", "", 0],
  ["bash -c 'echo \"$0 $1\"' x --help", "x --help\n", "", 0],
  ["bash -c 'echo hi' -e", "hi\n", "", 0],
  ["bash line.sh", "2\n", "", 0],
  [
    "printf 'echo hi\\nfalse\\necho after\\n' | bash -ex",
    "hi\n",
    "+ echo hi",
    1,
  ],
  ["sh -Q x.sh", "", "sh: -Q: invalid option", 2],
  ["sh -c", "", "sh: -c: option requires an argument", 2],
  ["sh -o badname x.sh", "", "sh: line 0: sh: badname: invalid option name", 2],
  ["sh -ec 'false; echo after'", "", "", 1],
  ["sh -n good.sh", "", "", 0],
];

describe("bash and sh options, as bash 5.3", () => {
  test.each(cases)("%s", async (command, stdout, stderr, exitCode) => {
    expect(await run(command)).toEqual({ stdout, stderr, exitCode });
  });

  // our parse error words differ from bash's, so only the run is pinned
  test.each([
    "bash -n bad.sh",
    "sh -n bad.sh",
    "printf 'echo hi\\nif then\\n' | bash -n",
  ])("%s runs nothing and exits 2", async (command) => {
    const result = await run(command);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(2);
  });

  // bash names the script and its line, ours names bash
  test("-eu stops at an unset variable", async () => {
    const result = await run("bash -eu u.sh");
    expect(result.stdout).toBe("");
    expect(result.stderr).toEndWith("undefined_x: unbound variable");
    expect(result.exitCode).toBe(1);
  });

  // bash prints the set -o table; a difference
  test("a bare -o wants its name", async () => {
    expect(await run("bash -o")).toEqual({
      stdout: "",
      stderr: "bash: -o: option requires an argument",
      exitCode: 2,
    });
  });

  test("--help in the option position prints the help", async () => {
    const result = await run("bash --norc --help");
    expect(result.stdout).toContain("--noprofile");
    expect(result.exitCode).toBe(0);
  });
});
