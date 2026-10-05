// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AttentionMode, EventSource } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import type { ProjectRow } from "../projects/index.ts";
import type { UserRow } from "../users/index.ts";

export type Event = {
  source: EventSource;
  automation: {
    id: string;
    name: string;
    tz: string;
    ownMemory: boolean;
    memoryGuidance: string;
    attentionMode: AttentionMode;
    attentionGuidance: string;
    disabledCapabilities: string[];
  };
  instructions: string;
  dueAt: number;
  deadlineMs: number | null;
  user: UserRow;
  project: ProjectRow;
  agent: AgentRow;
};
