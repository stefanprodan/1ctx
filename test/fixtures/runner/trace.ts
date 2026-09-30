// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One summoned turn's stored rows: two work rounds of calls with their
// tool rows, a signature on a call, a catalog MCP call and its lookup, a
// visual, a memory edit, a doc written past the command's first line, a
// call a cap left without a row, then the answer.

import { savedDocs } from "../../../src/server/sessions/messages.ts";
import type { Message } from "../../../src/shared/contracts/session.ts";
import type { ToolCall } from "../../../src/shared/contracts/tool.ts";

export const row = (
  fields: Partial<Message> & Pick<Message, "id" | "kind">,
): Message => ({
  sessionId: "s1",
  seq: 1,
  sendId: "send2",
  round: 1,
  slot: null,
  userId: null,
  agentId: "checker",
  content: "",
  uploads: null,
  files: null,
  saved: null,
  resultBytes: null,
  promptTokens: null,
  reasoning: "",
  html: "",
  status: "done",
  error: null,
  finishReason: null,
  toolCalls: null,
  toolCallId: null,
  toolName: null,
  model: "m",
  ttftMs: null,
  thinkingMs: null,
  upstream: null,
  servedModel: null,
  nativeFinish: null,
  createdAt: 0,
  finishedAt: 0,
  ...fields,
});

export const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});

export const tool = (
  id: string,
  round: number,
  name: string,
  status: Message["status"],
  saved: string[] | null = null,
): Message =>
  row({
    id: `t-${id}`,
    kind: "tool",
    round,
    toolCallId: id,
    toolName: name,
    status,
    saved: saved && savedDocs(saved),
    content: "a result the trace never carries",
  });

// the reading agent: its own MCP server and skill, not the ones the turn
// called
export const YOURS = {
  mcp: new Set(["mcp__fs__read"]),
  skills: new Set(["kube-ops"]),
};

export const TURN: Message[] = [
  row({
    id: "u",
    kind: "user",
    userId: "u1",
    agentId: null,
    content: "@checker is it true",
  }),
  row({
    id: "w1",
    kind: "reply",
    slot: "work",
    reasoning: "thinking the trace never carries",
    toolCalls: [
      {
        ...call("c1", "bash", {
          command: "kubectl get pods -A\n| grep Crash",
        }),
        signature: "sig-never-shown",
      },
      call("c2", "websearch", { query: "flux  2.8\nrelease", domain: "x.io" }),
      call("c3", "bash", { command: "kubectl get pods -A" }),
      call("c4", "mcp_call", {
        name: "mcp__github__search_issues",
        arguments: { q: "is:open crash", per_page: 5 },
      }),
      call("c10", "mcp_describe", { name: "mcp__github__search_issues" }),
    ],
  }),
  tool("c1", 1, "bash", "done"),
  tool("c2", 1, "websearch", "failed"),
  tool("c3", 1, "bash", "done"),
  tool("c4", 1, "mcp__github__search_issues", "done"),
  tool("c10", 1, "mcp_describe", "done"),
  row({
    id: "w2",
    kind: "reply",
    round: 2,
    slot: "work",
    toolCalls: [
      call("c5", "bash", { command: "kubectl get pods -A" }),
      call("c6", "visualize", { title: "Pods", html: "<svg></svg>" }),
      call("c7", "skill", { name: "flux-ops" }),
      call("c8", "webfetch", { url: "https://fluxcd.io/blog" }),
      call("c11", "memory_edit", {
        action: "set",
        topic: "flux",
        text: "a memory text the trace never carries",
      }),
      call("c12", "bash", {
        command: 'F=/knowledge/notes/pods.md\ncat > "$F" <<EOF\npods\nEOF',
      }),
      call("c9", "datetime", { timezone: "Europe/Bucharest" }),
    ],
  }),
  tool("c5", 2, "bash", "done"),
  tool("c6", 2, "visualize", "done"),
  tool("c7", 2, "skill", "stopped"),
  tool("c8", 2, "webfetch", "done"),
  tool("c11", 2, "memory_edit", "done"),
  tool("c12", 2, "bash", "done", ["/knowledge/notes/pods.md"]),
  row({
    id: "a",
    kind: "reply",
    round: 3,
    slot: "answer",
    content: "It is true.",
  }),
];

export const TRACE = `Calls in this turn, results not included:
bash kubectl get pods -A ok ×3
websearch flux 2.8 release failed
mcp__github__search_issues q=is:open crash per_page=5 ok (not your tool)
skill flux-ops failed (not your tool)
webfetch https://fluxcd.io/blog ok
memory_edit action=set topic=flux ok
bash F=/knowledge/notes/pods.md ok saved /knowledge/notes/pods.md
datetime timezone=Europe/Bucharest failed`;
