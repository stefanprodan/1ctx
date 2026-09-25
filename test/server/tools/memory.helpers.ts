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
      edit: () => ({ error: false, content: "" }),
      refuse: (_projectId, _sessionId, reason) => reason,
    },
  });
}

export function context(resultCut = TOOL_CAPS.resultCut): ToolContext {
  return {
    actor: null,
    web: null,
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
  automation: { id: "a1", ownMemory: true },
  phase: "memory" as const,
};
