// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One tool call as every phase runs it; each phase keeps its own order.

import type { Clock } from "../lib/clock.ts";
import { messageOf } from "../lib/errors.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { ToolCall } from "../providers/index.ts";
import type { Offered, ToolContext, ToolResult } from "./policy.ts";
import type { ActiveSend } from "./send.ts";

export type CallDeps = {
  tools: {
    run(
      offered: Offered,
      call: ToolCall,
      ctx: ToolContext,
    ): Promise<ToolResult>;
    logName?(offered: Offered, call: ToolCall): string;
  };
  clock: Clock;
  log: Log;
};

export function toolContext(
  send: ActiveSend,
  signal: AbortSignal,
  clock: Clock,
  extra: Pick<ToolContext, "web" | "keep" | "repos">,
): ToolContext {
  return {
    actor: {
      projectId: send.projectId,
      userId: send.policy.userId,
      agentId: send.policy.agentId,
      agentName: send.policy.agentName,
      sessionId: send.sessionId,
      origin: send.kind === "run" ? "automation" : "chat",
      sendStartedAt: send.startedAt,
    },
    signal,
    now: clock,
    budget: send.toolBudget,
    caps: send.policy.toolCaps,
    ...extra,
  };
}

// a tool that throws is a failed result whose content is the error
export async function runOne(
  deps: CallDeps,
  send: ActiveSend,
  offered: Offered,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const started = deps.clock();
  let result: ToolResult;
  try {
    result = await deps.tools.run(offered, call, ctx);
  } catch (error) {
    result = {
      content: messageOf(error),
      error: true,
      failure: error,
    };
  }
  if (result.error) {
    // a closed name: the model may call any name at all
    const tool = deps.tools.logName?.(offered, call) ?? "unknown";
    deps.log.warn("tool failed", {
      chat: send.sessionId,
      tool,
      duration: deps.clock() - started,
      ...(result.timedOut
        ? { cause: "timeout" }
        : errorFields(result.failure, false)),
      // a bash command that saved nothing: where it ended and why
      ...(result.ended === undefined
        ? {}
        : { phase: result.ended.phase, cause: result.ended.cause }),
    });
  }
  return result;
}
