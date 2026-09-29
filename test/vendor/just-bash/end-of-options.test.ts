// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// `--` ends the options, and an operand after it that starts with `-` is
// a file, as GNU coreutils 9.11 and the tools we follow answered.

import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";

const files = {
  "/w/f": "b\na\n",
  "/w/-v": "x\n",
  "/w/j": '{"a":1}\n',
  "/w/-j": '{"a":2}\n',
};

const cases: [string, string][] = [
  ["sort -- f", "a\nb\n"],
  ["sort -r -- -v f", "x\nb\na\n"],
  ["sort -- - < f", "a\nb\n"],
  ["head -n1 -- f", "b\n"],
  ["head -- -v", "x\n"],
  ["tail -n1 -- f", "a\n"],
  ["tail -- -v", "x\n"],
  ["cut -c1 -- -v", "x\n"],
  ["sed -n p -- -v", "x\n"],
  ["sed -- 1d f", "a\n"],
  ["jq -c -- . j", '{"a":1}\n'],
  ["jq -c . -- -j", '{"a":2}\n'],
  ["comm -- -v -v", "\t\tx\n"],
  ["tac -- f", "a\nb\n"],
  ["tac -- -v", "x\n"],
  ["md5sum -- -v", "401b30e3b8b5d629635a5c613cdb7919  -v\n"],
  ["sha1sum -- -v", "6fcf9dfbd479ed82697fee719b9f8c610a11ff2a  -v\n"],
  ["file -b -- -v", "ASCII text\n"],
  ["timeout -- 5 echo ok", "ok\n"],
  ["expr -- 1 + 1", "2\n"],
  ["find -- f", "f\n"],
  ["date -u -d @0 -- +%Y", "1970\n"],
  ["sleep -- 0 && echo ok", "ok\n"],
  ["basename -- -v", "-v\n"],
  ["dirname -- -v", ".\n"],
  ["chmod 600 -- -v && stat -c %a -- -v", "600\n"],
];

describe("-- ends the options", () => {
  for (const [script, stdout] of cases) {
    test(script, async () => {
      const bash = new Bash({ cwd: "/w", files });
      const r = await bash.exec(script);
      expect(r.stderr).toBe("");
      expect(r.stdout).toBe(stdout);
      expect(r.exitCode).toBe(0);
    });
  }
});
