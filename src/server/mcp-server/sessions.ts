// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { BadRequest, Conflict, HttpError, NotFound } from "../lib/errors.ts";
import { chatMarkdownParts } from "../sessions/index.ts";
import type { SessionsInput } from "./parse.ts";
import type { KeyPrincipal, McpServerDeps } from "./ports.ts";
import {
  asSent,
  asSentPart,
  cappedLines,
  cutUtf8,
  dataLabel,
  jsonLine,
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

const cursorOf = (row: { lastActivityAt: number; id: string }): string =>
  `${row.lastActivityAt}.${row.id}`;

function sessionLines(
  lines: readonly string[],
  cursors: readonly string[],
  next: string | null,
  continuation: (after: string) => string,
  maxBytes: number,
): string {
  const all = [...lines];
  if (next !== null) all.push(continuation(next));
  return cappedLines(
    all,
    (index) => continuation(cursors[index - 1]!),
    maxBytes,
  );
}

export function sessionsTool(
  deps: McpServerDeps,
  principal: KeyPrincipal,
  input: SessionsInput,
): McpResult {
  if (input.action === "search") {
    const project = deps.access.project(principal, input.projectId);
    const found = deps.sessions.search(project.id, input.q, input.after);
    const continuation = (after: string) =>
      `Read on with sessions action=search, projectId=${project.id}, q=${JSON.stringify(input.q)}, after=${JSON.stringify(after)}.\n`;
    const label = dataLabel("Session search results");
    const lines = found.hits.map((hit) =>
      jsonLine({
        id: hit.id,
        title: hit.title,
        kind: hit.kind,
        parentSessionId: hit.parentSessionId,
        lastActivityAt: new Date(hit.lastActivityAt).toISOString(),
        count: hit.count,
        lines: hit.lines.map((line) => ({
          ...line,
          text: asSent(line.text),
        })),
      }),
    );
    if (lines.length === 0 && found.next === null) {
      lines.push(`No session holds every word of ${JSON.stringify(input.q)}.`);
    }
    const page = sessionLines(
      lines,
      found.hits.map(cursorOf),
      found.next,
      continuation,
      MCP_PAGE_BYTES - Buffer.byteLength(label) - 1,
    );
    return textResult(`${label}\n${page}`);
  }
  if (input.action === "list") {
    const project = deps.access.project(principal, input.projectId);
    const found = deps.sessions.list(
      project.id,
      input.since?.at ?? null,
      input.after,
    );
    const readAt = input.readAt?.iso ?? new Date(deps.clock()).toISOString();
    const continuation = (after: string) =>
      `Read on with sessions action=list, projectId=${project.id}, since=${JSON.stringify(input.since?.iso ?? null)}, after=${JSON.stringify(after)}, readAt=${JSON.stringify(readAt)}.\n`;
    const footer = `List read at ${readAt}. Next time pass since=${JSON.stringify(readAt)}.`;
    const lines = found.sessions.map((row) =>
      jsonLine({
        ...row,
        lastActivityAt: new Date(row.lastActivityAt).toISOString(),
      }),
    );
    const page = sessionLines(
      lines,
      found.sessions.map(cursorOf),
      found.next,
      continuation,
      MCP_PAGE_BYTES - Buffer.byteLength(footer) - 1,
    );
    return textResult(
      `${page}${page === "" || page.endsWith("\n") ? "" : "\n"}${footer}\n`,
    );
  }
  const session = deps.sessions.byId(input.sessionId);
  if (session === null) throw new NotFound("no such chat");
  try {
    deps.access.project(principal, session.projectId);
  } catch (error) {
    if (error instanceof HttpError) throw new NotFound("no such chat");
    throw error;
  }
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
        ? "Session transcript ends.\n"
        : `Read on with sessions action=read, sessionId=${session.id}, messageId=${page.next.messageId}, offset=${page.next.offset}.\n`;
    const used =
      Buffer.byteLength(quoted("Session transcript", page.text)) +
      Buffer.byteLength(continuation) +
      (page.next === null ? 1 : 0);
    if (used <= MCP_PAGE_BYTES) {
      best = page;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const result = textResult(
    `${quoted("Session transcript", best.text)}${best.next === null ? "\nSession transcript ends.\n" : ""}`,
  );
  // first, so a client that cuts a long result still shows how to read on
  if (best.next !== null) {
    result.content.unshift({
      type: "text",
      text: `Read on with sessions action=read, sessionId=${session.id}, messageId=${best.next.messageId}, offset=${best.next.offset}.\n`,
    });
  }
  return result;
}
