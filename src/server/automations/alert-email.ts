// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An alert's email: when a run opens its automation's alert, the
// automation's owner is emailed the reason and a link to the run, in
// the transaction that opened it, under the same opt-in as an agent's
// email. A run that joins an open alert emails nobody, and an
// automation that flaps between flagged and clean emails its owner at
// most ALERT_EMAILS_PER_DAY times a day.

import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import {
  alertEmail,
  type EmailKind,
  type Enqueue,
  type Prepare,
  packBody,
  sessionPrepare,
} from "../email/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { type Clock, DAY_MS } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { UserRow } from "../users/index.ts";

// a constant, not a limits row: an editable cap waits until one is
// needed
export const ALERT_EMAILS_PER_DAY = 3;

export type AlertEmailDeps = {
  clock: Clock;
  log: Log;
  outbox: {
    enabled(): boolean;
    link(path: string): string;
    enqueue(fields: Enqueue): BusEvent[];
    register(kind: EmailKind, prepare: Prepare): void;
    // the automation's alert rows written at or after since, sent,
    // failed or queued
    countAlerts(automationId: string, since: number): number;
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
  deps.outbox.register(
    "alert",
    sessionPrepare(deps.canOpen, (path) => deps.outbox.link(path)),
  );
  const queue = (
    automation: AutomationSummary,
    sessionId: string,
  ): BusEvent[] => {
    if (!deps.outbox.enabled()) return [];
    const owner = deps.users.byId(automation.ownerId);
    if (owner === null || !reaches(deps, owner, automation.projectId)) {
      return [];
    }
    const sent = deps.outbox.countAlerts(automation.id, deps.clock() - DAY_MS);
    if (sent >= ALERT_EMAILS_PER_DAY) {
      deps.log.info("alert email capped", { automation: automation.id });
      return [];
    }
    const project = deps.projects.byId(automation.projectId);
    if (project === null) return [];
    const content = alertEmail({
      automation: automation.name,
      project,
      reason: deps.reason(sessionId),
      sessionId,
    });
    return deps.outbox.enqueue({
      kind: "alert",
      userId: owner.id,
      projectId: automation.projectId,
      sessionId,
      automationId: automation.id,
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
