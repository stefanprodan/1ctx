// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The session request parsers: a new chat, a message, a rename, and the
// stream's filters. A message is any text up to the byte cap, not
// blank; a title is one line up to the title cap.

import type {
  CreateSessionRequest,
  ForkSessionRequest,
  RenameSessionRequest,
  SendMessageRequest,
} from "../../shared/api/sessions.ts";
import { MAX_LAST_LINE } from "../../shared/contracts/session.ts";
import {
  hasLineBreak,
  MAX_MESSAGE_BYTES,
  MAX_SEARCH,
  MAX_TITLE,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

// the body cap: the message plus the JSON around it
export const MAX_SESSION_BODY = MAX_MESSAGE_BYTES + 1024;
export const MAX_SMALL_BODY = 1024;

export function parseMessage(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequest("message must be text");
  }
  if (new TextEncoder().encode(value).length > MAX_MESSAGE_BYTES) {
    throw new BadRequest(`message must be at most ${MAX_MESSAGE_BYTES} bytes`);
  }
  return value;
}

function id(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new BadRequest(`${what} must be an id`);
  }
  return value;
}

export function parseMessageId(value: unknown): string {
  return storedId(value, "messageId");
}

function storedId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-z]{12}$/.test(value)) {
    throw new BadRequest(`${name} must be an id`);
  }
  return value;
}

export function parseVisualParams(value: unknown): {
  id: string;
  messageId: string;
  index: number;
} {
  const params = fields(value, ["id", "messageId", "index"]);
  const index = params.index;
  if (
    typeof index !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(index) ||
    !Number.isSafeInteger(Number(index))
  ) {
    throw new BadRequest("index must be a non-negative integer");
  }
  return {
    id: storedId(params.id, "id"),
    messageId: parseMessageId(params.messageId),
    index: Number(index),
  };
}

export function parseCreateSession(body: unknown): CreateSessionRequest {
  const b = fields(body, ["projectId", "agentId", "message"]);
  return {
    projectId: id(b.projectId, "projectId"),
    agentId: id(b.agentId, "agentId"),
    message: parseMessage(b.message),
  };
}

export function parseSendMessage(body: unknown): SendMessageRequest {
  const b = fields(body, ["message"]);
  return { message: parseMessage(b.message) };
}

export function parseForkSession(body: unknown): ForkSessionRequest {
  const b = fields(body, ["messageId", "agentId", "title"]);
  return {
    messageId: parseMessageId(b.messageId),
    agentId: id(b.agentId, "agentId"),
    ...(b.title === undefined ? {} : { title: parseTitle(b.title) }),
  };
}

// the title as the user typed it, trimmed at the ends; blank, a line
// break or a length past the cap is refused
function parseTitle(value: unknown): string {
  if (typeof value !== "string") throw new BadRequest("title must be text");
  const title = value.trim();
  if (title === "") throw new BadRequest("title must not be blank");
  if (hasLineBreak(title)) throw new BadRequest("title must be one line");
  if (title.length > MAX_TITLE) {
    throw new BadRequest(`title must be at most ${MAX_TITLE} characters`);
  }
  return title;
}

export function parseRenameSession(body: unknown): RenameSessionRequest {
  const b = fields(body, ["title"]);
  return { title: parseTitle(b.title) };
}

// ?project=&q=: an optional project id and an optional search
export function parseStreamQuery(url: URL): {
  project: string | null;
  q: string;
  origin: "chat" | "automation" | null;
} {
  const seen = new Set<string>();
  for (const name of url.searchParams.keys()) {
    if (name !== "project" && name !== "q" && name !== "origin") {
      throw new BadRequest(`unknown parameter ${name}`);
    }
    if (seen.has(name)) throw new BadRequest(`duplicate parameter ${name}`);
    seen.add(name);
  }
  const project = url.searchParams.get("project");
  const q = url.searchParams.get("q") ?? "";
  const origin = url.searchParams.get("origin");
  if (q.length > MAX_SEARCH) throw new BadRequest("q is too long");
  if (origin !== null && origin !== "chat" && origin !== "automation") {
    throw new BadRequest("origin must be chat or automation");
  }
  return {
    project: project === null || project === "" ? null : project,
    q: q.trim(),
    origin,
  };
}

// the first line of the first message, cut to the cap
export function titleFrom(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > MAX_TITLE
    ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…`
    : line;
}

// the stream's last line: the first non-empty line, its Markdown
// markers stripped so a reply that opens with a heading reads as
// words and one with bold reads without the stars, cut as a title is
export function lineFrom(text: string): string {
  const line = text
    .split(/\r?\n/)
    .find((part) => part.trim() !== "")
    ?.trim();
  const stripped = (line ?? "")
    .replace(/^(?:(?:#+|[-*+]|\d+\.)\s+|>\s*)+/, "")
    .replace(/\*\*|__|`+/g, "")
    .trim();
  return stripped.length > MAX_LAST_LINE
    ? `${stripped.slice(0, MAX_LAST_LINE - 1).trimEnd()}…`
    : stripped;
}
