// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the session routes: the stream, one
// session, a new chat, a message into it, a rename, a stop.

import type { AgentSummary } from "../contracts/agent.ts";
import type {
  LastLine,
  SendSummary,
  SessionDetail,
  SessionSummary,
} from "../contracts/session.ts";

// GET /api/sessions?project=&q=&origin=: every session the caller may see,
// running first, then by last activity, each with what its row in
// the stream shows
export type SessionsResponse = { rows: StreamRow[] };

// one row of the stream: the session, its last send (the counters,
// the cause and the error while it is not running) and the last line
// the row shows for a session that is done, and the automation a run
// belongs to, drawn in the author's place; null for a chat
export type StreamRow = {
  session: SessionSummary;
  send: SendSummary | null;
  last: LastLine | null;
  automation: { id: string; name: string } | null;
};

// GET /api/sessions/:id, and the answer of POST /api/sessions
export type SessionResponse = SessionDetail;

// GET /api/sessions/:id/messages/:messageId/result
export type ToolResultResponse = {
  content: string;
  bytes: number;
  cut: boolean;
};

// POST /api/sessions: a chat in a project with an agent, and its first
// message
export type CreateSessionRequest = {
  projectId: string;
  agentId: string;
  message: string;
};

// POST /api/sessions/:id/messages
export type SendMessageRequest = { message: string };

// PATCH /api/sessions/:id: a new title, one line up to the title cap
export type RenameSessionRequest = { title: string };

// GET /api/projects/:id/agents: the agents the composer offers
export type ProjectAgentsResponse = { agents: AgentSummary[] };
