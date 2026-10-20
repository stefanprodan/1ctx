// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SendMessageRequest } from "../../shared/api/sessions.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import { transact } from "../db/index.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { envelope, type SessionRow, sessionDetail } from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { lastLine } from "./envelope.ts";
import { channelFirstWord } from "./summon.ts";
import type { RunnerDeps } from "./types.ts";

export function postChannel(
  deps: RunnerDeps,
  principal: Principal,
  channel: SessionRow,
  fields: SendMessageRequest,
  user: UserRow,
): SessionDetail {
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
    const touched = deps.sessions.touch(current.id, {
      status: "done",
      now,
    })!;
    return {
      result: sessionDetail(
        deps.sessions,
        touched,
        null,
        deps.limits.current().archivedDeleteDays,
        principal.userId,
      ),
      events: [
        envelope(touched, [posted], send, [], lastLine(posted, user.username)),
      ],
    };
  });
}
