// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the session routes: the feed, one
// session, a new chat, a message into it, a rename, a stop.

import type { CapabilityChange } from "../capabilities.ts";
import type { AgentSummary } from "../contracts/agent.ts";
import type { AutomationAlert } from "../contracts/automation.ts";
import type {
  LastLine,
  OpenedFile,
  QueuedMessage,
  SendSummary,
  SessionDetail,
  SessionSummary,
} from "../contracts/session.ts";
import type { NotSentReason } from "../words.ts";

// GET /api/sessions?project=&q=&origin=&before=: a page of the sessions
// the caller may see, running first, then by last activity, each with
// what its row in the feed shows. next is the cursor a later page
// passes as before, null when no row is left. With attention=1 in place
// of origin, the automations with an open alert, one line each as in
// All, newest alert first, paged by <since>.<automation id>
export type SessionsResponse = { rows: FeedRow[]; next: string | null };

// one row of the feed: the session, its last send (the counters,
// the cause and the error while it is not running) and the last line
// the row shows for a session that is done, and the automation a run
// belongs to, drawn in the author's place; null for a chat. runBy is
// who pressed Run now, whether or not they are in the project; null
// for a chat and a scheduled run. agent is the session's agent by name,
// credited on a line that says a send did not finish; null where the
// row is built without it; agentRetired is true once that agent was
// deleted, so the row draws the name as plain text. runs is how many
// runs the automation keeps, set only on its one line in All, which
// stands for them all, and on the lines of the Flagged pick.
// automation.alert is its open alert, null while none is. sendAgent is the agent of the last send, the
// summoned one's for a summoned turn, which a working or failed line
// names; null before the first send
export type FeedRow = {
  session: SessionSummary;
  agent: string | null;
  agentRetired: boolean;
  send: SendSummary | null;
  sendAgent: { name: string; retired: boolean } | null;
  last: LastLine | null;
  automation: {
    id: string;
    name: string;
    alert: AutomationAlert | null;
  } | null;
  runBy: { id: string; username: string } | null;
  runs: number | null;
};

// what a session envelope carries of the feed row beside its
// session: the fields that read the same for every viewer. runs hangs
// on the list's filter and search, so only a list read answers it
export type EnvelopeRow = Omit<FeedRow, "session" | "runs">;

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

// a chat's queue as the caller sees it after a write: every queued row
// and the caller's not-sent ones, at the session revision the write
// committed, which orders it against the envelopes' queues
export type QueueState = { queue: QueuedMessage[]; revision: number };

// the answer of POST /api/sessions/:id/messages, 202, when the chat's
// turn is running: the message waits and starts when the reply ends
export type QueuedResponse = QueueState & { queued: QueuedMessage };

// GET /api/sessions/:id/queued/:queuedId: the author's row whole, for an
// Edit or a Send again of a row a socket frame carried cut
export type QueuedRowResponse = { queued: QueuedMessage };

// PATCH /api/sessions/:id/queued/:queuedId: the author's new text, with
// the revision they saw; 409 once it started or changed. Answers the
// row as QueuedResponse
export type EditQueuedRequest = { message: string; revision: number };

// DELETE /api/sessions/:id/queued/:queuedId: the author's Remove,
// Discard and Send again, with the revision they saw; answers QueueState
export type RemoveQueuedRequest = { revision: number };

// GET /api/me/not-sent: the caller's messages that were not sent, newest
// first, each with its chat, for Home. line is the text's first line
export type NotSentRow = {
  id: string;
  sessionId: string;
  title: string;
  project: string;
  agent: string;
  line: string;
  reason: NotSentReason;
  changedAt: number;
};
export type NotSentResponse = { rows: NotSentRow[] };

// DELETE /api/me/not-sent: the caller's not-sent messages it names, the
// ones Home showed; an id not theirs or not sent is passed over
export type DiscardNotSentRequest = { ids: string[] };
export type DiscardNotSentResponse = { deleted: number };

// POST /api/sessions/:id/regenerate: the body is optional
export type RegenerateRequest = { capabilities?: CapabilityChange };

// PATCH /api/sessions/:id: a new title, one line up to the title cap
export type RenameSessionRequest = { title: string };

// POST /api/sessions/:id/archive takes no body and answers 204: a chat
// not running and not archived becomes read-only for good; a run is a
// 409, since it is read-only once it ends

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

// a credential a chat can turn off: one bound to its project
export type SwitchableCredential = { id: string; name: string };

// a repository a chat can turn off: one of its project's, with its ref,
// empty for the default branch
export type SwitchableRepo = { id: string; name: string; ref: string };

// GET /api/projects/:id/agents: the agents the composer offers, the
// capability keys a send starting now could turn off (`web` while the
// admin's web access is not off), and by agent id the MCP servers it is
// offered now and the skills it carries, in name order; an agent without
// one has no entry. The credentials and the repositories are the
// project's, for any agent, in name order
export type ProjectAgentsResponse = {
  agents: AgentSummary[];
  // the agent a new chat starts on for the caller: the one they last
  // picked, else the default; null with no agents
  startsOn: string | null;
  capabilities: string[];
  servers: Record<string, SwitchableServer[]>;
  skills: Record<string, SwitchableSkill[]>;
  credentials: SwitchableCredential[];
  repos: SwitchableRepo[];
};
