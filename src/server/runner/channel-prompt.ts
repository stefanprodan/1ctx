// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { knowledgeBlock } from "../../shared/knowledge.ts";
import { memoryBlock } from "../../shared/memory.ts";
import { offers, type SendPolicy } from "./policy.ts";
import {
  dateLine,
  projectLine,
  type RepoLines,
  reposBlock,
  userLine,
} from "./prompt.ts";

export const CHANNEL_LINE =
  "This is the project's channel. Members' posts carry their authors. Other agents' answers are marked with their names in brackets; write yours without a mark. You read their answers and call traces, never their results. Name the sources, paths and key figures behind your answer so the next agent can check them.";

export function channelSystem(policy: SendPolicy): string {
  return [
    projectLine(policy),
    policy.prompt.trim(),
    CHANNEL_LINE,
    policy.offered.skills.block,
    policy.offered.mcpCatalog,
    policy.offered.mcpPrompt.text,
    offers(policy.offered, "bash")
      ? knowledgeBlock(policy.knowledge.empty)
      : "",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

export function channelLocal(
  policy: SendPolicy,
  now: number,
  mcpNote: string,
  repos: RepoLines,
): string {
  return [
    userLine(policy),
    memoryBlock("project-memory", policy.projectMemory),
    dateLine(now),
    reposBlock(repos),
    mcpNote,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}
