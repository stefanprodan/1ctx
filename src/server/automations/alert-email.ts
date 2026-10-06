// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An alert's email: when a run opens its automation's alert, the
// automation's owner is emailed the reason and a link to the run, in
// the transaction that opened it, under the same opt-in as an agent's
// email. A run that joins an open alert emails nobody.

import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import {
  alertEmail,
  type EmailKind,
  type Enqueue,
  type Prepare,
  packBody,
  sessionPath,
  unpackBody,
} from "../email/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { UserRow } from "../users/index.ts";

export type AlertEmailDeps = {
  log: Log;
  outbox: {
    enabled(): boolean;
    link(path: string): string;
    enqueue(fields: Enqueue): BusEvent[];
    register(kind: EmailKind, prepare: Prepare): void;
  };
  users: { byId(id: string): UserRow | null };
  // the user may open the project: its owner, a member or an admin
  canOpen(userId: string, projectId: string): boolean;
  projects: {
    byId(id: string): { name: string; kind: "personal" | "team" } | null;
  };
  // the reason the run's row holds, null for a decider's mark
  reason(sessionId: string): string | null;
};

export type AlertEmails = {
  // in the caller's transaction, when the run opened the alert; the
  // events to return, none while email is off or the owner is not in
  opened(automation: AutomationSummary, sessionId: string): BusEvent[];
};

// what made the owner a recipient: enabled, able to open the project,
// past the forced password change and opted in
const reaches = (deps: AlertEmailDeps, user: UserRow, projectId: string) =>
  !user.disabled &&
  !user.mustChangePassword &&
  !user.emailPlaceholder &&
  user.emailFromAgents &&
  deps.canOpen(user.id, projectId);

export function alertEmails(deps: AlertEmailDeps): AlertEmails {
  deps.outbox.register("alert", (row, user) => {
    if (row.sessionId === null) return "deleted";
    if (row.projectId === null || !deps.canOpen(user.id, row.projectId)) {
      return "no-access";
    }
    if (user.mustChangePassword) return "no-access";
    if (!user.emailFromAgents) return "opted-out";
    const content = unpackBody(row);
    if (content === null) throw new Error("an alert row has no text");
    return content;
  });
  const queue = (
    automation: AutomationSummary,
    sessionId: string,
  ): BusEvent[] => {
    if (!deps.outbox.enabled()) return [];
    const owner = deps.users.byId(automation.ownerId);
    if (owner === null || !reaches(deps, owner, automation.projectId)) {
      return [];
    }
    const project = deps.projects.byId(automation.projectId);
    if (project === null) return [];
    const content = alertEmail({
      automation: automation.name,
      project,
      reason: deps.reason(sessionId),
      link: deps.outbox.link(sessionPath("automation", sessionId)),
    });
    return deps.outbox.enqueue({
      kind: "alert",
      userId: owner.id,
      projectId: automation.projectId,
      sessionId,
      subject: content.subject,
      body: packBody(content),
    });
  };
  return {
    opened(automation, sessionId) {
      // an email never fails the run's end it rides on
      try {
        return queue(automation, sessionId);
      } catch (err) {
        deps.log.warn("alert email failed", {
          automation: automation.id,
          ...errorFields(err),
        });
        return [];
      }
    },
  };
}
