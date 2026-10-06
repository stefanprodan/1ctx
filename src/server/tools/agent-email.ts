// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What email_user does once its call is well formed: every recipient is
// checked before any email is queued, and one refusal refuses the call,
// naming each user and why, so the model calls again with those it may
// email. The email is rendered once, then queued for each user in one
// transaction with the caps counted on the outbox, and checked again
// when each is sent.

import { type Db, transact } from "../db/index.ts";
import {
  agentEmail,
  type EmailKind,
  type Enqueue,
  type Prepare,
  packBody,
  sessionPrepare,
} from "../email/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { type Clock, DAY_MS } from "../lib/clock.ts";
import { ToolError } from "../lib/errors.ts";
import type { UserRow } from "../users/index.ts";
import {
  type AgentEmailPort,
  EMAILS_PER_PROJECT_DAY,
  EMAILS_PER_SEND,
  type EmailActor,
} from "./builtin/email.ts";

export type AgentEmailDeps = {
  db: Db;
  clock: Clock;
  outbox: {
    link(path: string): string;
    enqueue(fields: Enqueue): BusEvent[];
    register(kind: EmailKind, prepare: Prepare): void;
    countSession(sessionId: string, kind: EmailKind, since: number): number;
    countProject(projectId: string, kind: EmailKind, since: number): number;
  };
  users: { byUsername(username: string): UserRow | null };
  // the user may open the project's chats: the owner of a personal
  // project, a member or an admin of a team one; never a disabled user
  canOpen(userId: string, projectId: string): boolean;
  projects: {
    byId(id: string): { name: string; kind: "personal" | "team" } | null;
  };
};

// an address is never a recipient, only a user is
const ADDRESS = /\S@\S/;

// why a user named in a call is no recipient, as the model reads it
function refusal(
  deps: AgentEmailDeps,
  name: string,
  actor: EmailActor,
): { user: UserRow } | { why: string } {
  const where = actor.origin === "automation" ? "run" : "chat";
  if (ADDRESS.test(name)) {
    return { why: `${name} is an address; email goes to usernames only` };
  }
  // usernames are lowercase; a model may write one as a name
  const username = name.replace(/^@/, "").toLowerCase();
  const user = deps.users.byUsername(username);
  if (user === null) return { why: `@${username} is not a user` };
  if (!deps.canOpen(user.id, actor.projectId)) {
    return { why: `@${username} cannot open this ${where}` };
  }
  if (user.mustChangePassword) {
    return { why: `@${username} has not finished setting up their account` };
  }
  if (user.emailPlaceholder) {
    return { why: `@${username} has no email address` };
  }
  if (!user.emailFromAgents) {
    return { why: `@${username} does not take email from agents` };
  }
  return { user };
}

const named = (users: UserRow[]) =>
  users.map((user) => `@${user.username}`).join(", ");

export function agentEmails(deps: AgentEmailDeps): AgentEmailPort {
  deps.outbox.register(
    "agent",
    sessionPrepare(deps.canOpen, (path) => deps.outbox.link(path)),
  );

  return {
    email(actor, request) {
      const where = actor.origin === "automation" ? "run" : "chat";
      const users: UserRow[] = [];
      const refused: string[] = [];
      for (const name of request.to) {
        const checked = refusal(deps, name, actor);
        if ("why" in checked) refused.push(checked.why);
        else users.push(checked.user);
      }
      if (refused.length > 0) {
        throw new ToolError(
          `nothing was emailed. ${refused.join(". ")}.`,
          "email refused",
        );
      }
      // the same user named once by name and once with an @
      const recipients = [...new Map(users.map((u) => [u.id, u])).values()];
      const project = deps.projects.byId(actor.projectId);
      if (project === null) throw new Error("the project is gone");
      // rendered before the write lock: a long body takes a while
      const content = agentEmail({
        agent: actor.agentName,
        project,
        origin: actor.origin,
        subject: request.subject,
        sessionId: actor.sessionId,
        body: request.body,
      });
      const body = packBody(content);
      return transact(deps.db, () => {
        const now = deps.clock();
        const sent = deps.outbox.countSession(
          actor.sessionId,
          "agent",
          actor.sendStartedAt,
        );
        if (sent + recipients.length > EMAILS_PER_SEND) {
          throw new Error(
            `email limit reached: a ${where === "run" ? "run" : "turn"} may email ${EMAILS_PER_SEND} users, ${Math.max(0, EMAILS_PER_SEND - sent)} left. Tell the user in your answer instead`,
          );
        }
        const today = deps.outbox.countProject(
          actor.projectId,
          "agent",
          now - DAY_MS,
        );
        if (today + recipients.length > EMAILS_PER_PROJECT_DAY) {
          throw new Error(
            `email limit reached: agents may email ${EMAILS_PER_PROJECT_DAY} users a day in this project. Tell the user in your answer instead`,
          );
        }
        const events = recipients.flatMap((user) =>
          deps.outbox.enqueue({
            kind: "agent",
            userId: user.id,
            projectId: actor.projectId,
            sessionId: actor.sessionId,
            subject: content.subject,
            body,
          }),
        );
        return {
          result: `Email queued for ${named(recipients)}.`,
          events: events.slice(0, 1),
        };
      });
    },
  };
}
