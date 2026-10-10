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
  parseAutomationArgs,
} from "../../../src/server/tools/builtin/automation.ts";
import type { ToolContext } from "../../../src/server/tools/index.ts";
import { AUTOMATION_DEFAULTS } from "../../../src/shared/automation-defaults.ts";
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
