// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the session routes: the stream, one
// session, a new chat, a message into it, a stop.

import type { AgentSummary } from "../contracts/agent.ts";
import type { SessionDetail, SessionSummary } from "../contracts/session.ts";

// GET /api/sessions?project=&q=: every session the caller may see,
// running first, then by last activity
export type SessionsResponse = { sessions: SessionSummary[] };

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

// GET /api/projects/:id/agents: the agents the composer offers
export type ProjectAgentsResponse = { agents: AgentSummary[] };
