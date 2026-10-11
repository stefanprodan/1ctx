// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  READ_ACTIONS,
  TASK_READ_ACTIONS,
  TASK_WRITE_ACTIONS,
  WRITE_ACTIONS,
} from "../../src/server/mcp-server/serve.ts";
import { parseSkillMd } from "../../src/server/skills/index.ts";
import { AGENT_ENTRY_KINDS } from "../../src/shared/words.ts";

const text = readFileSync(
  join(import.meta.dir, "../../skills/external-tasks/SKILL.md"),
  "utf8",
);

describe("the external tasks skill", () => {
  test("parses as an Agent Skill", () => {
    const skill = parseSkillMd(text);
    expect(skill.name).toBe("external-tasks");
    expect(skill.description.length).toBeGreaterThan(0);
  });

  // the skill is what an outside agent follows, so every call it names
  // must be one the endpoint answers
  test("names only tool actions and report kinds the endpoint has", () => {
    const actions: Record<string, readonly string[]> = {
      tasks: [...TASK_READ_ACTIONS, ...TASK_WRITE_ACTIONS],
      knowledge: [...READ_ACTIONS, ...WRITE_ACTIONS],
    };
    const calls = [...text.matchAll(/`(tasks|knowledge) (\w+)/g)];
    expect(calls.length).toBeGreaterThan(5);
    for (const [, tool, action] of calls) {
      expect(actions[tool!]).toContain(action!);
    }
    const kinds = [...text.matchAll(/^- `(\w+)`:/gm)].map((m) => m[1]);
    expect(kinds.sort()).toEqual([...AGENT_ENTRY_KINDS].sort());
  });
});
