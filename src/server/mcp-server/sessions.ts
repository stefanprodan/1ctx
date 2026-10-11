// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { BadRequest, Conflict } from "../lib/errors.ts";
import { chatMarkdownParts } from "../sessions/index.ts";
import type { SessionsInput } from "./parse.ts";
import type { KeyPrincipal, McpServerDeps } from "./ports.ts";
import {
  asSentPart,
  cutUtf8,
  MCP_PAGE_BYTES,
  type McpResult,
  quoted,
  textResult,
} from "./result.ts";

type Part = { messageId: string | null; text: string };
type Next = { messageId: string; offset: number };

function pageAt(
  parts: readonly Part[],
  start: number,
  offset: number,
  bytes: number,
): { text: string; next: Next | null } {
  let index = start;
  let at = offset;
  let room = bytes;
  let text = "";
  while (index < parts.length) {
    const part = parts[index]!;
    if (at > part.text.length) {
      throw new BadRequest("offset is past the end of the message");
    }
    const page = cutUtf8(part.text, at, room);
    text += page.text;
    room -= Buffer.byteLength(page.text);
    if (page.next !== null) {
      if (part.messageId === null) return { text, next: null };
      return {
        text,
        next: { messageId: part.messageId, offset: page.next },
      };
    }
    index++;
    at = 0;
    if (index < parts.length && room === 0) {
      const following = parts[index]!;
      if (following.messageId === null) return { text, next: null };
      return { text, next: { messageId: following.messageId, offset: 0 } };
    }
  }
  return { text, next: null };
}

export function sessionsTool(
  deps: McpServerDeps,
  principal: KeyPrincipal,
  input: SessionsInput,
): McpResult {
  const session = deps.sessions.visible(principal, input.sessionId);
  const raw = chatMarkdownParts(
    session.title,
    deps.sessions.exportRows(session.id),
    "UTC",
  );
  const parts = raw.map((part, index) => ({
    messageId: part.messageId,
    text: `${index === 0 ? "" : "\n\n"}${asSentPart(part.text)}${index + 1 === raw.length ? "\n" : ""}`,
  }));
  let index = 0;
  if (input.messageId !== null) {
    index = parts.findIndex((part) => part.messageId === input.messageId);
    if (index < 0) {
      throw new Conflict("the session changed; read from the start");
    }
  } else if (input.offset > 0) {
    throw new BadRequest("messageId is required with offset");
  }
  const minimum =
    parts[index]?.messageId === null
      ? Buffer.byteLength(parts[index]!.text)
      : 0;
  let low = minimum;
  let high = MCP_PAGE_BYTES;
  let best = pageAt(parts, index, input.offset, minimum);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const page = pageAt(parts, index, input.offset, middle);
    const continuation =
      page.next === null
        ? ""
        : `Read on with sessions action=read, sessionId=${session.id}, messageId=${page.next.messageId}, offset=${page.next.offset}.`;
    const used =
      Buffer.byteLength(quoted("Session transcript", page.text)) +
      Buffer.byteLength(continuation);
    if (used <= MCP_PAGE_BYTES) {
      best = page;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const result = textResult(quoted("Session transcript", best.text));
  // first, so a client that cuts a long result still shows how to read on
  if (best.next !== null) {
    result.content.unshift({
      type: "text",
      text: `Read on with sessions action=read, sessionId=${session.id}, messageId=${best.next.messageId}, offset=${best.next.offset}.`,
    });
  }
  return result;
}
