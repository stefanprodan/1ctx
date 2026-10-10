// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  parsePatchAutomation,
  parseSaveAutomation,
} from "../../../src/server/automations/parse.ts";
import { proposeTask } from "../../../src/server/automations/propose.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  type AutomationsPort,
  makeAutomationTool,
  PROPOSAL_DESCRIPTION,
  parseAutomationArgs,
} from "../../../src/server/tools/builtin/automation.ts";
import type { ToolContext } from "../../../src/server/tools/index.ts";
import {
  AUTOMATION_DEFAULTS,
  OWN_MEMORY_GUIDANCE,
} from "../../../src/shared/automation-defaults.ts";
import {
  refusedProposalFields,
  refusedTaskValues,
} from "../../fixtures/tools/automation-proposals.ts";
import { testApp } from "../../helpers/app.ts";

const fields = {
  ...AUTOMATION_DEFAULTS,
  name: "task",
  agentId: "agent",
  instructions: "Check it.",
  schedule: "0 9 * * *",
  tz: "UTC",
  disabledCapabilities: [],
};

test("the proposal parser refuses fields an action never takes", () => {
  for (const args of refusedProposalFields) {
    expect(() => parseAutomationArgs(args, true)).toThrow("is not a field");
  }
  for (const action of ["update", "suspend", "resume", "run"]) {
    expect(() => parseAutomationArgs({ action }, true)).toThrow(
      "needs the task's id",
    );
  }
  expect(() => parseAutomationArgs({ action: "delete" }, true)).toThrow(
    "action must be",
  );
});

test("the description says which text goes where", () => {
  for (const sentence of [
    "Write instructions that stand alone: what to check and what is worth reporting.",
    "attentionGuidance says what in the answer needs a person, since a step after the run reads the answer, not the files.",
    "Keep it out of the instructions, and never tell the run to mark attention: it cannot.",
    "ownMemory is for what a run learns that no file holds, such as a source that fails and its workaround.",
    "Set ownMemory false when every run reads its state from files.",
    "memoryGuidance says what the note keeps. A step after the run writes it, so the instructions never say to update memory.",
  ]) {
    expect(PROPOSAL_DESCRIPTION).toContain(sentence);
  }
  expect(PROPOSAL_DESCRIPTION).not.toContain("when to mark attention");
  for (const call of [{ action: "create" }, { action: "update", id: "task" }]) {
    expect(
      parseAutomationArgs(
        {
          ...call,
          ownMemory: false,
          memoryGuidance: "",
          attentionGuidance: "A script failed.",
        },
        true,
      ),
    ).toMatchObject({
      fields: {
        ownMemory: false,
        memoryGuidance: "",
        attentionGuidance: "A script failed.",
      },
    });
  }
});

test("the default memory guidance leaves out what every run reads", () => {
  expect(OWN_MEMORY_GUIDANCE).toEndWith(
    " Leave out what the run reads from files or its task on every run.",
  );
});

test("draft fields use all the form parsers' value bounds", () => {
  for (const invalid of refusedTaskValues) {
    expect(() => parseSaveAutomation({ ...fields, ...invalid })).toThrow();
    expect(() =>
      parsePatchAutomation({ editRevision: 0, ...invalid }),
    ).toThrow();
  }
  expect(parseSaveAutomation(fields)).toEqual(fields);
});

test("a create deadline above the current limit writes no draft", async () => {
  const app = await testApp();
  try {
    expect(() =>
      proposeTask(
        {
          db: app.db,
          store: app.automations,
          drafts: app.automationDrafts,
          runDeadlineMs: () => 1,
        },
        {
          projectId: "project",
          sessionId: "chat",
          sendId: "send",
          messageId: "tool",
          userId: "user",
          agentId: "agent",
          action: "create",
          automationId: null,
          fields: { ...fields, deadlineMs: 2 },
          now: app.now.value,
        },
      ),
    ).toThrow("deadline is above the run limit");
    expect(app.automationDrafts.bySession("chat")).toEqual([]);
  } finally {
    await app.shutdown();
  }
});

test.serial(
  "a proposal takes its send place before awaiting, and a refusal returns it",
  async () => {
    const held: {
      resolve: (id: string) => void;
      reject: (error: Error) => void;
    }[] = [];
    const port: AutomationsPort = {
      byProject: () => [],
      byId: () => null,
      runDeadlineMs: () => 1,
      lastRun: () => null,
      switchNames: () => ({
        servers: [],
        skills: [],
        credentials: [],
        repos: [],
      }),
      userZone: () => "UTC",
      propose: () =>
        new Promise<string>((resolve, reject) =>
          held.push({ resolve, reject }),
        ),
    };
    const ctx: ToolContext = {
      sendId: "send",
      messageId: "tool",
      disabledCapabilities: [],
      web: null,
      actor: {
        projectId: "project",
        userId: "user",
        agentId: "agent",
        agentName: "agent",
        sessionId: "chat",
        origin: "chat",
        sendStartedAt: 0,
      },
      signal: new AbortController().signal,
      now: () => 0,
      budget: {
        bashCalls: 0,
        fetches: 0,
        searches: 0,
        visualBytes: 0,
        visuals: 0,
      },
      caps: DEFAULT_LIMITS,
    };
    const tool = makeAutomationTool(port, true);
    const args = {
      action: "create",
      name: "task",
      instructions: "check",
      schedule: "0 9 * * *",
    };
    const calls = Array.from({ length: 5 }, () => tool.run(args, ctx));
    expect(held).toHaveLength(5);
    await expect(tool.run(args, ctx)).rejects.toThrow("5 task proposals");
    const refused = calls[0]!;
    held[0]!.reject(new Error("refused before writing"));
    await expect(refused).rejects.toThrow("refused before writing");
    const replacement = tool.run(args, ctx);
    expect(held).toHaveLength(6);
    for (const entry of held.slice(1)) entry.resolve("draft");
    await Promise.all([...calls.slice(1), replacement]);
    await expect(tool.run(args, ctx)).rejects.toThrow("5 task proposals");
  },
);

test("a valid name is never reshaped", () => {
  for (const name of ["daily-check_", "a_", "weekly-cve", "x--y"]) {
    expect(
      parseAutomationArgs({ action: "update", id: "task", name }, true),
    ).toMatchObject({ fields: { name } });
  }
  expect(
    parseAutomationArgs(
      { action: "update", id: "task", name: " Weekly CVE " },
      true,
    ),
  ).toMatchObject({ fields: { name: "weekly-cve" } });
});
