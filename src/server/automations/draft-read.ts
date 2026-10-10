// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AutomationDraft } from "../../shared/contracts/automation-draft.ts";
import type { Db } from "../db/index.ts";

type Stored = Omit<AutomationDraft, "fields" | "askedBy" | "decidedBy"> & {
  projectId: string;
  sessionId: string;
  fields: string;
  userId: string;
  askedName: string;
  decidedBy: string | null;
  decidedName: string | null;
};

// Both detail and frames use this read, so usernames and fields cannot drift.
export function readDrafts(db: Db, column: "id" | "session_id", value: string) {
  return db
    .query<Stored, [string]>(
      `select d.id, s.project_id as projectId, d.session_id as sessionId,
         d.send_id as sendId, d.message_id as messageId, d.action, d.fields,
         d.automation_id as automationId, d.agent_id as agentId, d.state,
         d.user_id as userId, asked.username as askedName,
         d.decided_by as decidedBy, decided.username as decidedName,
         d.decided_at as decidedAt,
         d.created_automation_id as createdAutomationId,
         d.run_session_id as runSessionId, d.created_at as createdAt,
         d.expires_at as expiresAt
       from automation_drafts d
       join sessions s on s.id = d.session_id
       join users asked on asked.id = d.user_id
       left join users decided on decided.id = d.decided_by
       where d.${column} = ? order by d.created_at, d.id`,
    )
    .all(value)
    .map((row) => {
      const {
        projectId,
        sessionId,
        fields,
        userId,
        askedName,
        decidedBy,
        decidedName,
        ...rest
      } = row;
      const draft: AutomationDraft = {
        ...rest,
        fields: JSON.parse(fields),
        askedBy: { id: userId, username: askedName },
        decidedBy:
          decidedBy === null || decidedName === null
            ? null
            : { id: decidedBy, username: decidedName },
      };
      return { projectId, sessionId, draft };
    });
}
