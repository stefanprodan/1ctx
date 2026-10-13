// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  ExternalTaskEntry,
  ExternalTaskRow,
} from "../../shared/contracts/external-task.ts";
import type {
  ClaimEnd,
  EntryKind,
  ExternalTaskState,
} from "../../shared/words.ts";
import { lineFrom } from "../sessions/index.ts";

// Match trim()'s whitespace so a bounded preview still reaches its first line.
// The last entry is a report or a move, never a claim. Labels read their
// names now, so a rename shows at once.
export const TASK_SELECT = `select t.id, t.project_id, t.title, t.state,
    t.revision, t.edit_revision, t.claim_id, t.created_by,
    t.created_at, t.moved_at, u.username as creator_name,
    (select json_group_array(p.name order by l.position)
      from external_task_labels l join project_labels p on p.id = l.label_id
      where l.task_id = t.id) as labels,
    c.user_id as claim_user, cu.username as claim_username, c.key_id,
    c.key_name, c.started_at, c.active_at, e.kind as last_kind,
    substr(ltrim(e.text, char(9, 10, 11, 12, 13, 32, 160, 5760,
      8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
      8232, 8233, 8239, 8287, 12288, 65279)), 1, 600) as last_text,
    e.at as last_at, e.user_id as last_user, eu.username as last_username,
    e.key_name as last_key,
    (select count(*) from external_task_entries where task_id = t.id) as entries,
    exists (select 1 from external_task_entries a
      where a.task_id = t.id and a.kind = 'answer'
        and a.rowid > coalesce((select rowid from external_task_entries
          where id = c.after_entry_id), 0)
        and a.rowid > coalesce((select max(rowid) from external_task_entries
          where claim_id = c.id), 0)) as answered
  from external_tasks t
  left join users u on u.id = t.created_by
  left join external_task_claims c on c.id = t.claim_id
  left join users cu on cu.id = c.user_id
  left join external_task_entries e on e.rowid =
    (select rowid from external_task_entries where task_id = t.id
      and kind <> 'claim' order by at desc, rowid desc limit 1)
  left join users eu on eu.id = e.user_id`;

export type TaskKey = { userId: string; keyId: string; keyName: string };
export type TaskListRow = ExternalTaskRow & {
  answered: boolean;
  cursor: string;
};
export type ListInput = {
  projectIds: string[];
  states: ExternalTaskState[];
  // label names, any of them, shaped before they match; empty for
  // every task
  labels: string[];
  held: TaskKey | null;
  after: string | null;
  limit: number;
};

export type Claim = {
  id: string;
  task_id: string;
  user_id: string;
  key_id: string;
  key_name: string;
  started_at: number;
  active_at: number;
  ended_at: number | null;
  end_reason: ClaimEnd | null;
  last_task: string | null;
};

export type OpenClaim = Pick<Claim, "id" | "task_id" | "key_id">;

export type RawTask = {
  id: string;
  project_id: string;
  title: string;
  labels: string;
  state: ExternalTaskState;
  revision: number;
  edit_revision: number;
  created_by: string | null;
  creator_name: string | null;
  created_at: number;
  moved_at: number;
  claim_id: string | null;
  claim_user: string;
  claim_username: string | null;
  key_id: string;
  key_name: string;
  started_at: number;
  active_at: number;
  last_kind: EntryKind | null;
  last_text: string;
  last_at: number;
  last_user: string | null;
  last_username: string | null;
  last_key: string | null;
  entries: number;
  answered: number;
};

export type RawEntry = {
  id: string;
  kind: EntryKind;
  text: string;
  links: string;
  user_id: string | null;
  username: string | null;
  key_name: string | null;
  claim_id: string | null;
  claim_end: ClaimEnd | null;
  at: number;
};

export const taskRow = (raw: RawTask): ExternalTaskRow => ({
  id: raw.id,
  projectId: raw.project_id,
  title: raw.title,
  labels: JSON.parse(raw.labels),
  state: raw.state,
  revision: raw.revision,
  editRevision: raw.edit_revision,
  claim:
    raw.claim_id === null
      ? null
      : {
          id: raw.claim_id,
          userId: raw.claim_user,
          username: raw.claim_username ?? "",
          keyId: raw.key_id,
          keyName: raw.key_name,
          startedAt: raw.started_at,
          activeAt: raw.active_at,
        },
  last:
    raw.last_kind === null
      ? null
      : {
          kind: raw.last_kind,
          text: lineFrom(raw.last_text),
          at: raw.last_at,
          by:
            raw.last_user === null
              ? null
              : { id: raw.last_user, username: raw.last_username ?? "" },
          keyName: raw.last_key,
        },
  entries: raw.entries,
  createdBy:
    raw.created_by === null
      ? null
      : {
          id: raw.created_by,
          username: raw.creator_name ?? "",
        },
  createdAt: raw.created_at,
  movedAt: raw.moved_at,
});

export const entryRow = (raw: RawEntry): ExternalTaskEntry => ({
  id: raw.id,
  kind: raw.kind,
  text: raw.text,
  links: JSON.parse(raw.links),
  by:
    raw.user_id === null
      ? null
      : {
          id: raw.user_id,
          username: raw.username ?? "",
        },
  keyName: raw.key_name,
  claimId: raw.claim_id,
  claimEnd: raw.claim_end,
  at: raw.at,
});
