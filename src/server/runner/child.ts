// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent's run (docs/subagents.md), modelled on the memory phase:
// its own session, send, rounds, spend and offer, on its parent's
// policy snapshot and deadline. It is not a send of the registry's and
// never reaches endSend(), so no attention step, memory phase or
// decider follows it. Its parent's abort ends it, and the parent's
// delegate call waits for it, so the parent's send never ends first.

import type { Message } from "../../shared/contracts/session.ts";
import type { McpDigest } from "../../shared/mcp.ts";
import type { SendKind } from "../../shared/words.ts";
import type { BashCapability } from "../bash/index.ts";
import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { after, type Clock } from "../lib/clock.ts";
import { messageOf } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { ToolCall } from "../providers/index.ts";
import { childChanged } from "../sessions/index.ts";
import {
  type DelegateInput,
  type ToolContext,
  withoutOpen,
} from "../tools/index.ts";
import { childResult } from "./child-result.ts";
import { freeSlot, type SlotPort, takeSlot } from "./child-slots.ts";
import { type EndingDeps, finalize } from "./ending.ts";
import { offers, type SendPolicy, type ToolResult } from "./policy.ts";
import type { Registry } from "./registry.ts";
import { ProviderRefusal } from "./round.ts";
import { type ActiveSend, type ChildLink, claim, newSend } from "./send.ts";
import { type LoopDeps, toolLoop } from "./tool-loop.ts";
import type { SessionsPort } from "./writer-port.ts";

export type ChildDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  sessions: SessionsPort;
  loop: LoopDeps;
  ending: Pick<EndingDeps, "writer" | "pause" | "log">;
  bash: Pick<
    BashCapability,
    | "startKept"
    | "scratchFolder"
    | "copyScratch"
    | "returnScratch"
    | "dropScratch"
  >;
  registry: Registry;
  // the process cap now, which an extra stream counts under
  sendsRunning(): number;
  wake(): void;
  // the writer's hook: a child's rows to its parent's watchers
  childRows(link: ChildLink, sessionId: string, rows: Message[]): BusEvent[];
  messages(sessionId: string): Message[];
};

// the writer's hook: a child's rows to its parent's watchers alone,
// keyed by the delegate row
export const childRowsTo =
  (db: Db) =>
  (link: ChildLink, sessionId: string, rows: Message[]): BusEvent[] =>
    childChanged(db, {
      projectId: link.parent.projectId,
      rootId: link.parent.sessionId,
      messageId: link.rowId,
      childId: sessionId,
      rows,
    });

// the policy a subagent runs under: its parent's snapshot, its own
// offer and prompt, and what is left of the parent's deadline
export function childPolicy(
  parent: SendPolicy,
  deadlineMs: number | null,
): SendPolicy {
  const own = parent.childOffered;
  if (!own) throw new Error("the send offers no subagents");
  // the repositories mountRepos() named in the parent's bash
  const bash = parent.offered.tools.find((tool) => tool.name === "bash");
  const offered = {
    ...own,
    tools: own.tools.map((tool) =>
      tool.name === "bash" && bash !== undefined
        ? { ...tool, description: withoutOpen(bash.description) }
        : tool,
    ),
  };
  return {
    ...parent,
    summoned: null,
    offered,
    web: offered.web,
    childOffered: null,
    memoryOffered: null,
    attentionOffered: null,
    projectMemory: [],
    automationMemory: [],
    automation: null,
    deadlineMs,
    subagent: true,
  };
}

// the child's sends row, the one place it is written
export function childSendRow(
  sessions: SessionsPort,
  fields: {
    id: string;
    kind: SendKind;
    sessionId: string;
    policy: SendPolicy;
    firstMessageId: string;
    mcpDigest: McpDigest;
    now: number;
  },
) {
  return sessions.createSend({
    id: fields.id,
    kind: fields.kind,
    sessionId: fields.sessionId,
    userId: fields.policy.userId,
    agentId: fields.policy.agentId,
    providerId: fields.policy.providerId,
    model: fields.policy.model,
    firstMessageId: fields.firstMessageId,
    mcpDigest: fields.mcpDigest,
    child: true,
    now: fields.now,
  });
}

const turnOf = (send: ActiveSend) => (send.kind === "run" ? "run" : "turn");

// the child's session, send, task and first reply in one transaction,
// then its kept-file budget and its copy of the parent's /tmp
function startChild(
  deps: ChildDeps,
  link: ChildLink,
  policy: SendPolicy,
  input: DelegateInput,
  now: number,
): {
  send: ActiveSend;
  baseline: ReturnType<ChildDeps["bash"]["copyScratch"]> | null;
} {
  const parent = link.parent;
  const root = deps.sessions.byId(parent.sessionId);
  if (root === null) throw new Error("the chat is gone");
  const sessionId = newId();
  const sendId = newId();
  const taskId = newId();
  const replyId = newId();
  transact(deps.db, () => {
    deps.sessions.create({
      id: sessionId,
      projectId: root.projectId,
      ownerId: root.ownerId,
      agentId: policy.agentId,
      origin: root.origin,
      disabledCapabilities: policy.disabledCapabilities,
      parent: { sessionId: parent.sessionId, messageId: link.rowId },
      title: input.description,
      now,
    });
    childSendRow(deps.sessions, {
      id: sendId,
      kind: parent.kind,
      sessionId,
      policy,
      firstMessageId: taskId,
      mcpDigest: policy.offered.mcpPrompt.digest,
      now,
    });
    const task = deps.sessions.addUserMessage({
      id: taskId,
      sessionId,
      sendId,
      userId: policy.userId,
      content: input.task,
      now,
    });
    const reply = deps.sessions.addReply({
      id: replyId,
      sessionId,
      sendId,
      round: 1,
      agentId: policy.agentId,
      model: policy.model,
      now,
    });
    deps.sessions.touch(sessionId, { status: "running", now });
    return {
      result: undefined,
      events: deps.childRows(link, sessionId, [task, reply]),
    };
  });
  const send = newSend({
    id: sendId,
    sessionId,
    projectId: parent.projectId,
    startedBy: parent.startedBy,
    kind: parent.kind,
    op: parent.op,
    policy,
    firstMessageId: taskId,
    replyId,
    now,
  });
  send.child = link;
  // the parent's trees, which it lets go of once this child has ended;
  // the mount notices stay the parent's to hand out
  send.repos =
    parent.repos === null
      ? null
      : {
          off: [],
          moved: [],
          tool: { ...parent.repos.tool, notice: () => "" },
          release() {},
        };
  if (!offers(policy.offered, "bash")) return { send, baseline: null };
  const kept = deps.bash.startKept(sessionId, null);
  let next = kept.next;
  send.keep = {
    take: () => next++,
    maxBytes: kept.maxBytes,
    used: kept.used,
    maxFiles: kept.maxFiles,
    files: kept.files,
  };
  return {
    send,
    baseline: deps.bash.copyScratch(parent.sessionId, sessionId),
  };
}

// a delegate call of the parent's: refused past childrenPerSend, else
// its place taken in the turn the round's calls launch, then the child
// run to its end. Never throws for the child's own failure
export async function delegate(
  deps: ChildDeps,
  parent: ActiveSend,
  input: DelegateInput,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const rowId = parent.openTools.get(call);
  if (rowId === undefined || !parent.policy.childOffered) {
    throw new Error("delegate is not offered here");
  }
  const limits = parent.policy.limits;
  const children = parent.children;
  if (children.started >= limits.childrenPerSend) {
    return {
      content: `Not run: this ${turnOf(parent)} has used its ${limits.childrenPerSend} subagents. Do the rest yourself.`,
      error: true,
    };
  }
  children.started++;
  const folder = deps.bash.scratchFolder(parent.sessionId, children.folders);
  children.folders.add(folder);
  const port: SlotPort = {
    atOnce: limits.childrenAtOnce,
    takeExtra: () => deps.registry.takeExtra(deps.sendsRunning()),
    freeExtra: () => {
      deps.registry.freeExtra();
      deps.wake();
    },
  };
  const slot = await takeSlot(children, port, ctx.signal);
  if (slot === null) {
    return {
      content: "The subagent was stopped before it began.",
      error: true,
    };
  }
  try {
    return await runChild(deps, { parent, rowId, folder }, input, ctx.signal);
  } finally {
    freeSlot(children, slot, port);
  }
}

async function runChild(
  deps: ChildDeps,
  link: ChildLink,
  input: DelegateInput,
  signal: AbortSignal,
): Promise<ToolResult> {
  const parent = link.parent;
  const now = deps.clock();
  // the parent's deadline, never a fresh one
  const left =
    parent.policy.deadlineMs === null
      ? null
      : parent.startedAt + parent.policy.deadlineMs - now;
  if (left !== null && left <= 0) {
    return { content: "The subagent ran out of time.", error: true };
  }
  const policy = childPolicy(parent.policy, left);
  const { send, baseline } = startChild(deps, link, policy, input, now);
  const stop = () => {
    const cause =
      parent.cause === "deadline" || parent.cause === "shutdown"
        ? parent.cause
        : "stop";
    send.ending.abort();
    claim(send, cause);
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const disarm =
    left === null
      ? () => {}
      : after(deps.clock, left, () => void claim(send, "deadline"));
  try {
    try {
      const end = await toolLoop(deps.loop, send);
      claim(send, end.cause, end.error);
    } catch (error) {
      if (send.cause === null && error instanceof ProviderRefusal) {
        send.refusal = { status: error.status };
      }
      claim(send, "failure", messageOf(error));
    }
    const finalized = await finalize(deps.ending, send);
    send.end(finalized);
  } finally {
    disarm();
    signal.removeEventListener("abort", stop);
    if (send.tools !== null) await send.tools.catch(() => {});
    send.letGo();
  }
  deps.log.info("child end", {
    chat: parent.sessionId,
    child: send.sessionId,
    cause: send.cause!,
    rounds: send.roundNo,
    tools: send.budget.calls,
    prompt_tokens: send.promptTokens,
    completion_tokens: send.completionTokens,
    duration: deps.clock() - send.startedAt,
  });
  return childResult(
    {
      cause: send.cause!,
      error: send.error,
      ...answerOf(deps.messages(send.sessionId)),
      folder: link.folder,
      ...(await returned(deps, send, link, baseline)),
    },
    {
      answerChars: policy.limits.childAnswerChars,
      resultCut: policy.toolCaps.resultCut,
    },
  );
}

// the child's done answer, and the last words it wrote
function answerOf(rows: Message[]): { answer: string | null; last: string } {
  const replies = rows.filter((row) => row.kind === "reply");
  return {
    answer:
      replies.findLast((row) => row.slot === "answer" && row.status === "done")
        ?.content ?? null,
    last: replies.findLast((row) => row.content.trim() !== "")?.content ?? "",
  };
}

// what the child added or changed in its /tmp, back in its parent's
async function returned(
  deps: ChildDeps,
  send: ActiveSend,
  link: ChildLink,
  baseline: ReturnType<ChildDeps["bash"]["copyScratch"]> | null,
): Promise<{ copied: string[]; left: string[] }> {
  if (baseline === null) return { copied: [], left: [] };
  try {
    return await deps.bash.returnScratch(
      send.sessionId,
      link.parent.sessionId,
      link.folder,
      baseline,
    );
  } catch (error) {
    deps.log.warn("child files not returned", {
      chat: link.parent.sessionId,
      child: send.sessionId,
      ...errorFields(error),
    });
    // a child is never continued, so its copy of the parent's /tmp goes
    deps.bash.dropScratch(send.sessionId);
    return { copied: [], left: [] };
  }
}
