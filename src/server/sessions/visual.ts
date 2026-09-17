// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ToolVisualResponse } from "../../shared/api/sessions.ts";
import type { Message } from "../../shared/contracts/session.ts";
import type { ToolCall } from "../../shared/contracts/tool.ts";
import { hasLineBreak, MAX_TITLE } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";

function argumentsObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function validTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= MAX_TITLE &&
    !hasLineBreak(value)
  );
}

export function offWireCall(call: ToolCall): ToolCall {
  if (call.name !== "visualize") return call;
  const args = argumentsObject(call.arguments);
  // Rebuilding only the known fields keeps malformed arguments and
  // unexpected nested values from carrying the source on the wire.
  return {
    ...call,
    arguments: JSON.stringify({
      ...(validTitle(args?.title) ? { title: args.title } : {}),
      html:
        typeof args?.html === "string"
          ? Buffer.byteLength(args.html, "utf8")
          : 0,
    }),
  };
}

export function readVisual(
  db: Db,
  reply: Message,
  index: number,
): ToolVisualResponse | null {
  const call = reply.toolCalls?.[index];
  if (reply.kind !== "reply" || call?.name !== "visualize") return null;
  const args = argumentsObject(call.arguments);
  if (
    !args ||
    !validTitle(args.title) ||
    typeof args.html !== "string" ||
    args.html.trim() === "" ||
    Object.keys(args).some((key) => key !== "title" && key !== "html")
  ) {
    return null;
  }
  // Provider ids may repeat. Tool rows keep the call array's order
  // within a round, which survives a fork unchanged.
  const tool = db
    .query<
      Pick<Message, "status" | "error" | "toolCallId" | "toolName">,
      [string, string, number, number, number]
    >(
      `select status, error, tool_call_id as toolCallId, tool_name as toolName
       from messages
       where session_id = ? and send_id = ? and round = ?
         and kind = 'tool' and seq > ?
       order by seq limit 1 offset ?`,
    )
    .get(reply.sessionId, reply.sendId, reply.round, reply.seq, index);
  return tool?.status === "done" &&
    tool.error === null &&
    tool.toolName === call.name &&
    tool.toolCallId === call.id
    ? { title: args.title, html: args.html }
    : null;
}
