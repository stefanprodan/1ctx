// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The session request parsers: a new chat, a message, a rename, and the
// stream's filters. A message is any text up to the byte cap, not
// blank; a title is one line up to the title cap.

import type {
  CreateSessionRequest,
  RenameSessionRequest,
  SendMessageRequest,
} from "../../shared/api/sessions.ts";
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
  if (typeof value !== "string" || !/^[0-9a-z]{12}$/.test(value)) {
    throw new BadRequest("messageId must be an id");
  }
  return value;
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

// the title as the user typed it, trimmed at the ends; blank, a line
// break or a length past the cap is refused
export function parseRenameSession(body: unknown): RenameSessionRequest {
  const b = fields(body, ["title"]);
  if (typeof b.title !== "string") throw new BadRequest("title must be text");
  const title = b.title.trim();
  if (title === "") throw new BadRequest("title must not be blank");
  if (hasLineBreak(title)) throw new BadRequest("title must be one line");
  if (title.length > MAX_TITLE) {
    throw new BadRequest(`title must be at most ${MAX_TITLE} characters`);
  }
  return { title };
}

// ?project=&q=: an optional project id and an optional search
export function parseStreamQuery(url: URL): {
  project: string | null;
  q: string;
} {
  const seen = new Set<string>();
  for (const name of url.searchParams.keys()) {
    if (name !== "project" && name !== "q") {
      throw new BadRequest(`unknown parameter ${name}`);
    }
    if (seen.has(name)) throw new BadRequest(`duplicate parameter ${name}`);
    seen.add(name);
  }
  const project = url.searchParams.get("project");
  const q = url.searchParams.get("q") ?? "";
  if (q.length > MAX_SEARCH) throw new BadRequest("q is too long");
  return {
    project: project === null || project === "" ? null : project,
    q: q.trim(),
  };
}

// the first line of the first message, cut to the cap
export function titleFrom(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > MAX_TITLE
    ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…`
    : line;
}
