// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the session routes: the stream, one
// session, a new chat, a message into it, a rename, a stop.

import type { CapabilityChange } from "../capabilities.ts";
import type { AgentSummary } from "../contracts/agent.ts";
import type {
  LastLine,
  OpenedFile,
  SendSummary,
  SessionDetail,
  SessionSummary,
} from "../contracts/session.ts";

// GET /api/sessions?project=&q=&origin=&before=: a page of the sessions
// the caller may see, running first, then by last activity, each with
// what its row in the stream shows. next is the cursor a later page
// passes as before, null when no row is left
export type SessionsResponse = { rows: StreamRow[]; next: string | null };

// one row of the stream: the session, its last send (the counters,
// the cause and the error while it is not running) and the last line
// the row shows for a session that is done, and the automation a run
// belongs to, drawn in the author's place; null for a chat. runBy is
// who pressed Run now, whether or not they are in the project; null
// for a chat and a scheduled run. agent is the session's agent by name,
// credited on a line that says a send did not finish; null where the
// row is built without it. runs is how many runs the automation keeps,
// set only on its one line in All, which stands for them all
export type StreamRow = {
  session: SessionSummary;
  agent: string | null;
  send: SendSummary | null;
  last: LastLine | null;
  automation: { id: string; name: string } | null;
  runBy: { id: string; username: string } | null;
  runs: number | null;
};

// GET /api/sessions/:id, and the answer of POST /api/sessions
export type SessionResponse = SessionDetail;

// GET /api/sessions/:id/messages/:messageId/result
export type ToolResultResponse = {
  content: string;
  bytes: number;
  cut: boolean;
};

export type ToolVisualResponse = {
  title: string;
  html: string;
};

// GET /api/sessions/:id/messages/:messageId/files/:index: one file a
// bash row opened, whole. html is the document itself for a visual, the
// md- rendering for Markdown, and for code the highlighted (hljs-) or
// escaped text without the pre and code elements; text is the source
// for Markdown and code, what Copy takes, and empty for a visual
export type OpenedFileResponse = OpenedFile & { html: string; text: string };

// POST /api/sessions: a chat in a project with an agent, and its first
// message. uploads names the caller's staged items in the project, at
// most MAX_UPLOADS_PER_MESSAGE distinct ids, claimed by the send
export type CreateSessionRequest = {
  projectId: string;
  agentId: string;
  message: string;
  uploads?: string[];
  capabilities?: CapabilityChange;
};

// POST /api/sessions/:id/messages
// capabilities carries only the switches the person touched; the server
// applies it to the chat's set inside the send's first transaction
export type SendMessageRequest = {
  message: string;
  uploads?: string[];
  capabilities?: CapabilityChange;
};

// POST /api/sessions/:id/regenerate: the body is optional
export type RegenerateRequest = { capabilities?: CapabilityChange };

// PATCH /api/sessions/:id: a new title, one line up to the title cap
export type RenameSessionRequest = { title: string };

// POST /api/sessions/:id/fork: the turn to fork at, the agent the fork
// runs on, and its title, "Fork of <the source's>" when absent
// A fork at a user turn leaves that message unsent: its text is the new
// chat's draft, and the files it carried are staged again for the
// caller, their ids answered beside the session as `draftUploads`
export type ForkSessionRequest = {
  messageId: string;
  agentId: string;
  title?: string;
};

// the fork's answer, 201: the new chat, and the staged ids of the files
// an unsent user turn carried, empty for any other fork
export type ForkSessionResponse = SessionDetail & { draftUploads: string[] };

// an MCP server a chat can turn off: one an agent is offered now, with
// how many of its tools that is
export type SwitchableServer = { id: string; name: string; tools: number };

// a skill a chat can turn off: one its agent carries
export type SwitchableSkill = { id: string; name: string };

// GET /api/projects/:id/agents: the agents the composer offers, the
// capability keys a send starting now could turn off (`web` while the
// admin's web access is not off), and by agent id the MCP servers it is
// offered now and the skills it carries, in name order; an agent without
// one has no entry
export type ProjectAgentsResponse = {
  agents: AgentSummary[];
  capabilities: string[];
  servers: Record<string, SwitchableServer[]>;
  skills: Record<string, SwitchableSkill[]>;
};
