// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { silent } from "../../../src/server/lib/log.ts";
import type { MemoryWork } from "../../../src/server/memory/index.ts";
import type { SkillBody } from "../../../src/server/skills/index.ts";
import {
  type SkillsPort,
  type ToolsArea,
  toolsArea,
} from "../../../src/server/tools/index.ts";
import { TOOL_CAPS } from "../../../src/server/tools/limits.ts";
import type { ToolContext } from "../../../src/server/tools/types.ts";
import { memoryDb } from "../../helpers/db.ts";

export const now = Date.UTC(2026, 8, 16, 0, 0, 0);

export function area(): ToolsArea {
  const skills: SkillsPort = {
    forAgent: () => [],
    body: (): SkillBody | null => null,
    file: () => null,
  };
  return toolsArea({
    db: memoryDb(),
    fetcher: (async () => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch,
    secret: () => null,
    clock: () => now,
    log: silent,
    version: "vtest",
    render: (markdown) => markdown,
    skills,
    memory: {
      work(projectId, automationId): MemoryWork {
        return {
          target: { projectId, automationId },
          baseRevision: 0,
          entries: [],
          operations: [],
          failedRounds: 0,
        };
      },
    },
    sessions: {
      memorySnapshot(projectId, sessionId) {
        if (projectId !== "p1" || sessionId === "missing") return null;
        return {
          id: sessionId,
          title: "A chat",
          lastActivityAt: 20,
          markdown: "# A chat\n\n## @user 1970-01-01 00:00\n\nA long answer.",
        };
      },
    },
    markers: {
      unread(_automationId, _projectId, _cap, exclude) {
        return {
          chats: exclude.includes("s1")
            ? []
            : [
                {
                  id: "s1",
                  title: "A chat",
                  author: "user",
                  lastActivityAt: 20,
                  userMessages: 2,
                  readBefore: true,
                  changedSince: true,
                },
              ],
          remaining: 0,
        };
      },
    },
  });
}

export function context(resultCut = TOOL_CAPS.resultCut): ToolContext {
  return {
    actor: null,
    signal: new AbortController().signal,
    now: () => now,
    budget: {
      bashCalls: 0,
      fetches: 0,
      searches: 0,
      visualBytes: 0,
      visuals: 0,
    },
    caps: { ...TOOL_CAPS, resultCut },
  };
}

export const task = {
  projectId: "p1",
  automation: { id: "a1", projectMemory: true, ownMemory: true },
  phase: "main" as const,
};
