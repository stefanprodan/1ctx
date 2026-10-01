// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A session as the wire exposes it: the row in the feed and the
// project's list, its messages, the send in flight and its live tail.
// The revision counts the session's transactions; a client applies an
// event only when its revision is above the one it holds.

import type { MessageUpload } from "../uploads.ts";
import type {
  ArchiveReason,
  Avatar,
  EventSource,
  MessageKind,
  MessageStatus,
  NotSentReason,
  OpenedKind,
  QueuedState,
  SendCause,
  SendKind,
  SessionOrigin,
  SessionStatus,
} from "../words.ts";
import type { ToolCall } from "./tool.ts";

export type SessionSummary = {
  id: string;
  projectId: string;
  ownerId: string;
  agentId: string;
  origin: SessionOrigin;
  forkedFromId: string | null;
  // the automation a run belongs to; null for a chat, and for a run
  // whose automation was deleted
  automationId: string | null;
  // what started a run: its schedule, or someone's Run now, who owns
  // the session; null for a chat
  runSource: EventSource | null;
  // the first line of the first message, cut to 80 characters; a
  // run's is its automation's name
  title: string;
  status: SessionStatus;
  revision: number;
  createdAt: number;
  lastActivityAt: number;
  // the last round the provider counted; null before the first
  usage: RoundUsage | null;
  // what the chat turned off for itself, sorted keys of
  // shared/capabilities.ts; empty for a run, whose automation holds its own
  disabledCapabilities: string[];
  // set once a chat is archived, for good; null while it takes turns,
  // and always for a run, which is read-only once it ends
  archived: { at: number; reason: ArchiveReason } | null;
  // the chance, 0 to 1, that a finished run needs a person, as the
  // default decider answered; null for a chat and a run not asked
  attention: number | null;
};

// what the chat page says of an archived chat beyond the summary: who
// archived it by hand, null for the other reasons and once that user is
// deleted, and when the delete limit removes it, as of the limit when
// the detail was read
export type SessionArchive = {
  by: { id: string; username: string } | null;
  keptUntil: number;
};

// what the provider counted for one round: the prompt is the whole
// request, so prompt plus completion is the context the session used.
// The window is the model's as the round saw it, since an agent's
// model can change under a session
export type RoundUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  // USD, when the provider states one
  cost: number | null;
  contextLength: number | null;
};

export type { OpenedKind };

// the docs a bash command wrote: the first /knowledge paths in commit
// order, bounded, how many it wrote in all, and the one directory they
// share, null when they are in several
export type SavedDocs = {
  paths: string[];
  count: number;
  dir: string | null;
};

// a file a bash command put on the page with open, as the tool row
// carries it: the stored copy's text stays behind and the file route
// answers it
export type OpenedFile = {
  // the absolute path in the mount, as it was resolved
  path: string;
  kind: OpenedKind;
  // the highlighter's language for code; null for plain text and for
  // the other kinds
  language: string | null;
  // the UTF-8 size and the line count of the stored copy
  bytes: number;
  lines: number;
  // a visual's title, from the page's title element or the file's name;
  // null for the other kinds
  title: string | null;
};

export type Message = {
  id: string;
  sessionId: string;
  // the order within the session
  seq: number;
  kind: MessageKind;
  // the send this row belongs to; every message row carries it, so the
  // client groups a send's rows without reading the call arrays
  sendId: string;
  // the provider round within the send, from 1; the answer round included
  round: number;
  // the server's word on where a reply row shows: "answer" in the main
  // column, "work" inside the fold; null while a reply streams and on
  // every non-reply row
  slot: "work" | "answer" | null;
  // who wrote it: a user for a user message, an agent for a reply
  userId: string | null;
  agentId: string | null;
  // a tool result stays in storage but travels as empty content; every
  // other row carries its content unchanged
  content: string;
  // the files a user message carried, as they were at the send; null on
  // every other row and on a message without files
  uploads: MessageUpload[] | null;
  // the files a bash command opened onto the page with open, in open
  // order, without their text; null on every other row and on a bash
  // row that opened nothing
  files: OpenedFile[] | null;
  // the docs a bash command wrote; null on every other row and on a bash
  // row that wrote no doc
  saved: SavedDocs | null;
  // the UTF-8 byte length of stored tool content on the wire; null on
  // every non-tool row
  resultBytes: number | null;
  // the context sent to a completed summary round; null otherwise
  promptTokens: number | null;
  reasoning: string;
  // the rendered content, empty for a user message
  html: string;
  status: MessageStatus;
  error: string | null;
  finishReason: string | null;
  // the calls a reply row asked for, null on every other row; read for
  // rendering the fold, never for placement
  toolCalls: ToolCall[] | null;
  // the call a tool row answers and the tool that ran, both null on
  // every other row
  toolCallId: string | null;
  toolName: string | null;
  model: string | null;
  ttftMs: number | null;
  thinkingMs: number | null;
  // what a router said about a reply's round, null where it did not say:
  // the upstream that served it, the model that answered when it is not
  // the one asked for, and the upstream's own stop reason when it
  // differs from finishReason
  upstream: string | null;
  servedModel: string | null;
  nativeFinish: string | null;
  createdAt: number;
  finishedAt: number | null;
};

// the last row a person or the agent wrote to a chat, as the feed
// shows it: a user message, or an answer reply that is done. The
// author is the username or the agent's name; the text is the first
// non-empty line of the content with its leading markers stripped,
// cut to the cap
export type LastLine = {
  seq: number;
  author: string;
  text: string;
};

export const MAX_LAST_LINE = 160;

export type SendSummary = {
  id: string;
  sessionId: string;
  kind: SendKind;
  userId: string;
  agentId: string;
  providerId: string;
  model: string;
  status: SessionStatus;
  cause: SendCause | null;
  error: string | null;
  // the user message the send answers
  firstMessageId: string;
  // provider rounds so far, the answer round included; from 1
  rounds: number;
  // tool calls launched, not calls a cap cut
  toolCalls: number;
  // the round the memory phase started at; null for a send without one
  memoryRound: number | null;
  // why the memory phase did not update the note, null when it did
  memoryError: string | null;
  // edits the commit skipped because the note moved during the run
  memorySkipped: number | null;
  // another agent answered this one turn, summoned by the first word
  summoned: boolean;
  // prompt plus completion tokens over every round the provider counted
  tokens: number;
  startedAt: number;
  finishedAt: number | null;
};

// the runner's snapshot of a send in flight. Between rounds, while a
// round's tools run, nothing streams: the "tools" variant carries the
// send and the stream sequence but no row, and the client must accept
// that without seeding a live row and without a refetch. The "reply"
// variant is a reply streaming, as before
export type VisualDraft = {
  messageId: string;
  callIndex: number;
  title?: string;
  html: string;
};

// a round waiting to ask its provider again: this attempt of max
export type LiveRetry = { attempt: number; max: number };

export type LiveSend = {
  // the previews at seq, absent when no call is streaming a visual
  drafts?: VisualDraft[];
  // present only while a round waits to retry
  retry?: LiveRetry;
} & (
  | {
      phase: "reply";
      sendId: string;
      messageId: string;
      seq: number;
      content: string;
      reasoning: string;
      html: string;
      htmlAt: number;
    }
  | {
      phase: "tools";
      sendId: string;
      seq: number;
    }
);

export type SessionAuthor = {
  id: string;
  username: string;
  fullName: string;
};

export type SessionDetail = {
  session: SessionSummary;
  forkedFrom: {
    id: string;
    title: string | null;
    origin: SessionOrigin | null;
  } | null;
  messages: Message[];
  // the send in flight, or the last one; null before the first
  send: SendSummary | null;
  live: LiveSend | null;
  authors: SessionAuthor[];
  // the agents its rows name, a retired one included, so a reply keeps
  // its agent's name and avatar once the agent is deleted
  agents: SessionAgent[];
  // set exactly when session.archived is; the client reads the detail
  // again when an envelope archives the chat it shows
  archive: SessionArchive | null;
  // the messages waiting for the reply to end, oldest first; a not-sent
  // one only to its author
  queued: QueuedMessage[];
};

// the characters of a queued message's text a socket frame carries
export const QUEUED_PREVIEW = 2048;

// a message sent while the chat's turn ran, kept apart from the
// transcript until it starts. revision counts its own changes, and an
// edit or a remove names the one it saw; uploads counts its staged
// files. On a socket frame text is a preview of QUEUED_PREVIEW
// characters at most, cut then true; the detail and an answer carry it
// whole
export type QueuedMessage = {
  id: string;
  author: { id: string; username: string };
  text: string;
  cut: boolean;
  uploads: number;
  state: QueuedState;
  reason: NotSentReason | null;
  revision: number;
  queuedAt: number;
};

// retired is true once an admin deleted the agent: its name is plain
// text, never a link, and it is offered nowhere
export type SessionAgent = {
  id: string;
  name: string;
  avatar: Avatar;
  retired: boolean;
};
