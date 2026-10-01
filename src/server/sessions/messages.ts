// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message, SavedDocs } from "../../shared/contracts/session.ts";
import type { MessageKind, MessageStatus } from "../../shared/words.ts";
import type { OpenedRecord } from "../bash/index.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import { writeOpenedFiles } from "./opened-store.ts";
import {
  MESSAGE_COLUMNS,
  message,
  type RawMessage,
  type ReplyFinish,
} from "./rows.ts";

type AgentMessageFields = {
  id?: string;
  sessionId: string;
  sendId: string;
  round: number;
  agentId: string;
  model: string;
  now: number;
};

export function nextSeq(db: Db, sessionId: string): number {
  return db
    .query<{ n: number }, [string]>(
      "select coalesce(max(seq), 0) + 1 as n from messages where session_id = ?",
    )
    .get(sessionId)!.n;
}

function read(db: Db, id: string): Message {
  const raw = db
    .query<RawMessage, [string]>(
      `select ${MESSAGE_COLUMNS} from messages where id = ?`,
    )
    .get(id)!;
  return message(raw);
}

export function addAgentMessage(
  db: Db,
  kind: Extract<MessageKind, "reply" | "summary">,
  fields: AgentMessageFields,
): Message {
  const id = fields.id ?? newId();
  const seq = nextSeq(db, fields.sessionId);
  db.query(
    `insert into messages (id, session_id, seq, kind, send_id, round,
       agent_id, model, status, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'streaming', ?)`,
  ).run(
    id,
    fields.sessionId,
    seq,
    kind,
    fields.sendId,
    fields.round,
    fields.agentId,
    fields.model,
    fields.now,
  );
  return read(db, id);
}

export function addToolRows(
  db: Db,
  calls: {
    id?: string;
    sessionId: string;
    sendId: string;
    round: number;
    toolCallId: string;
    toolName: string;
    now: number;
  }[],
): Message[] {
  return calls.map((call) => {
    const id = call.id ?? newId();
    db.query(
      `insert into messages (id, session_id, seq, kind, send_id, round, tool_call_id, tool_name, status, created_at)
       values (?, ?, ?, 'tool', ?, ?, ?, ?, 'streaming', ?)`,
    ).run(
      id,
      call.sessionId,
      nextSeq(db, call.sessionId),
      call.sendId,
      call.round,
      call.toolCallId,
      call.toolName,
      call.now,
    );
    return read(db, id);
  });
}

export type ToolFinish = {
  content: string;
  status: Exclude<MessageStatus, "streaming">;
  error: string | null;
  finishedAt: number;
  opened?: readonly OpenedRecord[] | null;
  // the /knowledge paths a bash command wrote, for another agent's trace
  saved?: readonly string[] | null;
};

// a command may write hundreds of docs; the row keeps the first paths
export const SAVED_PATHS = 50;

const parent = (path: string) => path.slice(0, path.lastIndexOf("/"));

export function savedDocs(paths: readonly string[]): SavedDocs {
  const dir = parent(paths[0] ?? "");
  return {
    paths: paths.slice(0, SAVED_PATHS),
    count: paths.length,
    dir: paths.every((path) => parent(path) === dir) ? dir : null,
  };
}

// guarded by status, so a tool that ends after a terminal cleanup
// writes nothing
export function finishToolRow(db: Db, id: string, fields: ToolFinish) {
  const saved = fields.saved?.length
    ? JSON.stringify(savedDocs(fields.saved))
    : null;
  const changed =
    db
      .query(
        `update messages set content = ?, status = ?, error = ?,
           finished_at = ?, saved = ?
         where id = ? and kind = 'tool' and status = 'streaming'`,
      )
      .run(
        fields.content,
        fields.status,
        fields.error,
        fields.finishedAt,
        saved,
        id,
      ).changes > 0;
  if (changed && fields.opened?.length) {
    writeOpenedFiles(db, id, fields.opened);
  }
  return changed;
}

export function finishReply(db: Db, id: string, fields: ReplyFinish): boolean {
  return (
    db
      .query(
        `update messages set content = ?, reasoning = ?, reasoning_details = ?, html = ?,
       status = ?, error = ?, finish_reason = ?, slot = ?, tool_calls = ?,
       ttft_ms = ?, thinking_ms = ?, upstream = ?, served_model = ?,
       native_finish = ?, finished_at = ?
     where id = ? and status = 'streaming'`,
      )
      .run(
        fields.content,
        fields.reasoning,
        fields.reasoningDetails.length > 0
          ? JSON.stringify(fields.reasoningDetails)
          : null,
        fields.html,
        fields.status,
        fields.error,
        fields.finishReason,
        fields.slot,
        fields.toolCalls && fields.toolCalls.length > 0
          ? JSON.stringify(fields.toolCalls)
          : null,
        fields.ttftMs,
        fields.thinkingMs,
        fields.upstream,
        fields.servedModel,
        fields.nativeFinish,
        fields.finishedAt,
        id,
      ).changes > 0
  );
}

// the commit each repository was mounted at in a turn, kept on the
// turn's first message: repository id to commit
export type MountedRepos = Record<string, string>;

export function setMountedRepos(
  db: Db,
  messageId: string,
  mounted: MountedRepos,
): void {
  db.query("update messages set mounted_repos = ? where id = ?").run(
    JSON.stringify(mounted),
    messageId,
  );
}

export function readMountedRepos(
  db: Db,
  messageId: string,
): MountedRepos | null {
  const row = db
    .query<{ mounted_repos: string | null }, [string]>(
      "select mounted_repos from messages where id = ?",
    )
    .get(messageId);
  return row?.mounted_repos
    ? (JSON.parse(row.mounted_repos) as MountedRepos)
    : null;
}

// each earlier send's mounted commits, newest first, from its first
// message: the sends of a chat are few where its messages are many
export function mountedBefore(
  db: Db,
  sessionId: string,
  sendId: string,
): MountedRepos[] {
  return db
    .query<{ mounted_repos: string }, [string, string]>(
      `select messages.mounted_repos from sends
       join messages on messages.id = sends.first_message_id
       where sends.session_id = ? and sends.id != ?
         and messages.mounted_repos is not null
       order by sends.started_at desc, sends.rowid desc`,
    )
    .all(sessionId, sendId)
    .map((row) => JSON.parse(row.mounted_repos) as MountedRepos);
}
