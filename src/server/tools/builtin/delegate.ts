// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// delegate hands a task to a subagent, a fresh copy of the agent in a
// child session (docs/subagents.md). The runner runs the child behind
// the port compose passes, so the tools area never imports the runner.
// It runs outside the registry: a child is bounded by the send's
// deadline, never the call timeout.

import { sanitize } from "../../../shared/memory.ts";
import { cutCodePoints } from "../../../shared/text.ts";
import { hasLineBreak, MAX_MESSAGE_BYTES } from "../../../shared/words.ts";
import type { ToolCall } from "../../providers/index.ts";
import { failedCall, parsedArgs } from "../registry.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";

export const DELEGATE_TOOL = "delegate";
// what the work fold heads the child's group with
export const MAX_DELEGATE_DESCRIPTION = 80;

export type DelegateInput = { description: string; task: string };

// the runner's side: the child run to its end, as the parent's result;
// the call is the one whose tool row the child hangs off
export type DelegatePort = (
  input: DelegateInput,
  call: ToolCall,
  ctx: ToolContext,
) => Promise<ToolResult>;

export const DELEGATE_DESCRIPTION =
  "Hand a task to a subagent: a fresh copy of you with your tools, less delegate, memory and email, that can write only to its own /tmp. Delegate work that would fill your context with material you need once: exploring a repository, reading many files or long MCP results, web research. Independent tasks run in parallel when you call delegate several times in one round. Answer small questions yourself, and keep work that needs this conversation. The subagent sees nothing but task and a copy of your /tmp, so put everything it needs in task: the goal, where to look, what to return. It answers briefly; files it writes come back under /tmp/<name>/, listed in the result.";

export function makeDelegateTool(): Tool {
  return {
    name: DELEGATE_TOOL,
    description: DELEGATE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "A few words on what the subagent does.",
        },
        task: {
          type: "string",
          description: "The whole instruction. The subagent sees nothing else.",
        },
      },
      required: ["description", "task"],
      additionalProperties: false,
    },
    async run() {
      throw new Error("delegate runs through the runner");
    },
  };
}

// the arguments as the child gets them; a throw is the model's to write
// again. A long description is cut, never refused: it only heads a fold
export function delegateInput(args: Record<string, unknown>): DelegateInput {
  if (Object.keys(args).some((key) => key !== "description" && key !== "task"))
    throw new Error("delegate accepts only description and task");
  const { description, task } = args;
  if (typeof description !== "string" || hasLineBreak(description.trim()))
    throw new Error("description must be one line");
  const words = sanitize(description);
  if (words === "") throw new Error("description must say what it does");
  if (typeof task !== "string" || task.trim() === "")
    throw new Error("task must hold the whole instruction");
  if (Buffer.byteLength(task) > MAX_MESSAGE_BYTES)
    throw new Error(`task must be at most ${MAX_MESSAGE_BYTES} bytes`);
  return {
    description:
      [...words].length <= MAX_DELEGATE_DESCRIPTION
        ? words
        : `${cutCodePoints(words, MAX_DELEGATE_DESCRIPTION - 1).trimEnd()}…`,
    task: task.trim(),
  };
}

// one delegate call: a bad argument is a failed result the model reads,
// and a throw from the runner one too, so the parent goes on
export async function runDelegate(
  port: DelegatePort | undefined,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    if (port === undefined) throw new Error("subagents are not configured");
    return await port(delegateInput(parsedArgs(call)), call, ctx);
  } catch (error) {
    return failedCall(error, ctx);
  }
}
