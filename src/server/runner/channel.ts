// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelPostResponse,
  SendMessageRequest,
} from "../../shared/api/sessions.ts";
import { transact } from "../db/index.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { envelope, type SessionRow } from "../sessions/index.ts";
import { requiredUser } from "./authors.ts";
import { lastLine } from "./envelope.ts";
import { channelFirstWord } from "./summon.ts";
import type { MessageAnswer, RunnerDeps } from "./types.ts";

function postChannel(
  deps: RunnerDeps,
  channel: SessionRow,
  fields: SendMessageRequest,
  userId: string,
): ChannelPostResponse {
  if (fields.capabilities !== undefined) {
    throw new BadRequest("a channel has no capability switches");
  }
  if (
    channelFirstWord(fields.message, channel.projectId, {
      agents: deps.agents,
      users: deps.users,
      projects: deps.projects,
    }) === "summon"
  ) {
    throw new Conflict("summons in a channel are not built yet");
  }
  const user = requiredUser(deps.users, userId);
  const now = deps.clock();
  const messageId = newId();
  const sendId = newId();
  return transact(deps.db, () => {
    const current = deps.sessions.byId(channel.id);
    if (current === null || current.origin !== "channel") {
      throw new NotFound("no such chat");
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
    return {
      result: { session: touched, messages: [posted], send },
      events: [
        envelope(touched, [posted], send, [], lastLine(posted, user.username)),
      ],
    };
  });
}

export function channelMessage(
  deps: RunnerDeps,
  principal: Principal,
  sessionId: string,
  fields: SendMessageRequest,
  otherwise: () => MessageAnswer,
): MessageAnswer {
  const session = deps.visible(principal, sessionId);
  if (session.origin !== "channel") return otherwise();
  return {
    status: 201,
    body: postChannel(deps, session, fields, principal.userId),
  };
}
