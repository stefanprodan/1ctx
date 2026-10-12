// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command cut by its execution deadline ends the script with 124
// wherever it runs: a loop, if, case, subshell, group or function body,
// or a [[ ]] test, never as a plain failure the script goes on from.
// The clock is frozen, so only the command's own deadline timer can stop
// it, the case the script's later time check used to miss.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";

const realNow = Date.now;

function shell() {
  const fs = new InMemoryFs();
  // A sleep that never ends on its own: the deadline is what stops it.
  const bash = new Bash({
    fs,
    cwd: "/",
    defenseInDepth: true,
    sleep: () => new Promise<void>(() => {}),
    executionLimits: { maxExecutionTimeMs: 20 },
  });
  return { bash, fs };
}

const bodies: Record<string, string> = {
  loop: "while :; do echo x > /late; sleep 5; done",
  "for loop": "for i in 1 2; do echo x > /late; sleep 5; done",
  "arithmetic for loop":
    "for ((i=0; i<2; i++)); do echo x > /late; sleep 5; done",
  if: "if true; then echo x > /late; sleep 5; fi",
  case: "case a in a) echo x > /late; sleep 5;; esac",
  subshell: "( echo x > /late; sleep 5 )",
  group: "{ echo x > /late; sleep 5; } > /out",
  function: "f() { echo x > /late; sleep 5; }; f",
  conditional: "echo x > /late; [[ -n $(sleep 5) ]]",
};

describe("a command cut by its deadline", () => {
  beforeEach(() => {
    const frozen = realNow();
    Date.now = () => frozen;
  });
  afterEach(() => {
    Date.now = realNow;
  });

  for (const [name, body] of Object.entries(bodies)) {
    test.serial(`ends the script with 124 in a ${name} body`, async () => {
      const { bash, fs } = shell();
      const result = await bash.exec(`${body}; echo after > /after`);
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain("sleep exceeded its execution deadline");
      expect(await fs.exists("/after")).toBe(false);
    });
  }

  test.serial("timeout inside a loop still lets the script go on", async () => {
    const { bash } = shell();
    const result = await bash.exec(
      "for i in 1; do timeout 0.001 sleep 5; echo after $?; done",
    );
    expect(result).toMatchObject({ stdout: "after 124\n", exitCode: 0 });
  });
});
