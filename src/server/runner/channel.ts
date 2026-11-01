// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelPostResponse,
  SendMessageRequest,
} from "../../shared/api/sessions.ts";
import { CHANNEL_NO_IMAGES } from "../../shared/images.ts";
import { summonName } from "../../shared/summon.ts";
import { transact } from "../db/index.ts";
import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  TooManyRequests,
} from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import {
  envelope,
  MAX_QUEUED_PER_CHAT,
  type PendingRow,
  queueChanged,
  type SessionRow,
} from "../sessions/index.ts";
import {
  liveAuthor,
  principalOf,
  requiredAgent,
  requiredUser,
} from "./authors.ts";
import { channelFloor } from "./channel-context.ts";
import { lastLine } from "./envelope.ts";
import { type Registry, waitsForPlace } from "./registry.ts";
import { channelFirstWord } from "./summon.ts";
import type { MessageAnswer, RunnerDeps } from "./types.ts";

type ChannelDeps = RunnerDeps & {
  registry: Registry;
  queue: {
    readonly closed: boolean;
    wake(): void;
    changed(pendingId?: string): void;
  };
};

export function pendingFields(deps: RunnerDeps, row: PendingRow) {
  const user = liveAuthor(deps.users.byId(row.authorId));
  const principal = principalOf(user);
  const session = deps.visible(principal, row.sessionId);
  const post = deps.sessions.message(row.messageId);
  if (
    session.origin !== "channel" ||
    post?.sessionId !== session.id ||
    post.kind !== "user"
  )
    throw new BadRequest("the channel post is gone");
  return {
    sessionId: session.id,
    session,
    project: deps.access.project(principal, session.projectId),
    user,
    agent: requiredAgent(deps.agents, row.agentId),
    summoned: `#${session.title}`,
    title: session.title,
    turn: { posted: post, author: user.username, pendingId: row.id },
    changes: [],
  };
}

export { CHANNEL_NO_IMAGES };

function postChannel(
  deps: ChannelDeps,
  channel: SessionRow,
  fields: SendMessageRequest,
  userId: string,
): { status: 201 | 202; body: ChannelPostResponse } {
  const { registry, queue } = deps;
  if (fields.capabilities !== undefined) {
    throw new BadRequest("a channel has no capability switches");
  }
  if (fields.images !== undefined) {
    throw new BadRequest(CHANNEL_NO_IMAGES);
  }
  const agent =
    channelFirstWord(fields.message, channel.projectId, {
      agents: deps.agents,
      users: deps.users,
      projects: deps.projects,
    }) === "summon"
      ? deps.agents.byName(summonName(fields.message)!)!
      : null;
  const user = requiredUser(deps.users, userId);
  if (agent !== null) {
    channelFloor(
      { agentName: agent.name, contextLength: agent.model.contextLength },
      deps.limits.current(),
    );
  }
  queue.wake();
  let waiting = queue.closed;
  if (agent !== null && !waiting) {
    try {
      registry.admit(
        channel.id,
        { userId: user.id, projectId: channel.projectId },
        deps.limits.current(),
        agent.id,
      );
    } catch (error) {
      if (!waitsForPlace(error)) throw error;
      waiting = true;
    }
  }
  const now = deps.clock();
  const messageId = newId();
  const sendId = newId();
  const { pendingId, body } = transact(deps.db, () => {
    const current = deps.sessions.byId(channel.id);
    if (current === null || current.origin !== "channel") {
      throw new NotFound("no such chat");
    }
    if (agent !== null && waiting) {
      if (
        deps.sessions.pending
          .ofSession(current.id)
          .filter((row) => row.reason === null).length >= MAX_QUEUED_PER_CHAT
      ) {
        throw new TooManyRequests("this channel has too many turns waiting");
      }
      if (
        deps.sessions.pending.userCount(user.id) +
          deps.sessions.queue.userCount(user.id) >=
        deps.limits.current().queuedPerUser
      ) {
        throw new TooManyRequests(
          "you have too many turns or messages waiting",
        );
      }
    }
    const uploads = fields.uploads?.length
      ? deps.uploads.claimUploads(current.projectId, current.id, [
          { userId: user.id, messageId, ids: fields.uploads },
        ])[0]!
      : null;
    const send = deps.sessions.createPost({
      id: sendId,
      sessionId: current.id,
      userId: user.id,
      firstMessageId: messageId,
      now,
    });
    const posted = deps.sessions.addUserMessage({
      id: messageId,
      sessionId: current.id,
      sendId: send.id,
      userId: user.id,
      content: fields.message,
      uploads,
      now,
    });
    deps.db
      .query(
        "update sessions set last_activity_at = ?, revision = revision + 1 where id = ?",
      )
      .run(now, current.id);
    const touched = deps.sessions.byId(current.id)!;
    const pending =
      agent === null
        ? null
        : deps.sessions.pending.insert({
            sessionId: current.id,
            messageId,
            authorId: user.id,
            agentId: agent.id,
            queuedAt: now,
          });
    return {
      result: {
        pendingId: pending?.id ?? null,
        body: { session: touched, messages: [posted], send },
      },
      events: [
        envelope(touched, [posted], send, [], lastLine(posted, user.username)),
        ...(pending === null
          ? []
          : queueChanged(deps.db, current.id, { shared: true })),
      ],
    };
  });
  if (pendingId === null) return { status: 201, body };
  queue.changed(pendingId);
  const pending = deps.sessions.pending.byId(pendingId);
  if (pending !== null) {
    if (pending.reason !== null) {
      throw new BadRequest(
        `the channel turn was not started: ${pending.reason}`,
      );
    }
    return { status: 202, body };
  }
  if (
    !registry
      .inSession(channel.id)
      .some(
        (send) => send.firstMessageId === messageId && send.terminal === null,
      )
  ) {
    throw new Conflict("the channel turn is no longer pending or running");
  }
  return { status: 201, body };
}

export function cancelPending(
  deps: RunnerDeps,
  principal: Principal,
  sessionId: string,
  id: string,
): void {
  const session = deps.visible(principal, sessionId);
  if (session.origin !== "channel")
    throw new Conflict("only a channel has pending turns");
  transact(deps.db, () => {
    const turn = deps.sessions.pending.byId(id);
    if (turn === null || turn.sessionId !== sessionId)
      throw new Conflict("the turn has started or was cancelled");
    if (turn.authorId !== principal.userId && principal.role !== "admin") {
      throw new Forbidden("only its summoner or an admin cancels a turn");
    }
    deps.sessions.pending.remove(id);
    return {
      result: undefined,
      events: queueChanged(deps.db, sessionId, { shared: true }),
    };
  });
  deps.wake();
}

export function channelMessage(
  deps: ChannelDeps,
  principal: Principal,
  sessionId: string,
  fields: SendMessageRequest,
  otherwise: () => MessageAnswer,
): MessageAnswer {
  const session = deps.visible(principal, sessionId);
  if (session.origin !== "channel") return otherwise();
  return postChannel(deps, session, fields, principal.userId);
}
