// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A queued message holds its images until its turn takes them; the
// channel takes none.

import { describe, expect, test } from "bun:test";
import { DAY_MS } from "../../../src/server/lib/clock.ts";
import { CHANNEL_NO_IMAGES } from "../../../src/server/runner/channel.ts";
import { CANNOT_READ_IMAGES } from "../../../src/server/runner/images.ts";
import type { QueuedResponse } from "../../../src/shared/api/sessions.ts";
import { sessionSettled } from "../../helpers/chat.ts";
import { imageApp, userTexts } from "./helpers.ts";

describe("a queued message's images", () => {
  test("are held while it waits and move to its message when its turn starts", async () => {
    const s = await imageApp();
    const started = await s.start("first", []);
    const a = await s.stage(s.chat.projectId);
    const b = await s.stage(s.chat.projectId);
    const res = await s.send(started.sessionId, {
      message: "look",
      images: [a.id, b.id],
    });
    expect(res.status).toBe(202);
    const { queued } = (await res.json()) as QueuedResponse;
    expect(queued.images).toBe(2);
    for (const [position, id] of [a.id, b.id].entries()) {
      expect(s.image(id)).toMatchObject({
        queued_id: queued.id,
        message_id: null,
        expires_at: null,
        position,
      });
    }
    // an edit keeps them
    const edit = await s.chat.member.call(
      "PATCH",
      `/api/sessions/${started.sessionId}/queued/${queued.id}`,
      { body: { message: "look again", revision: queued.revision } },
    );
    expect(edit.status).toBe(200);
    expect(s.image(a.id)?.queued_id).toBe(queued.id);
    const next = s.chat.scripted.reached(2);
    started.script.reply("hi");
    const script = await next;
    expect(userTexts(script).at(-1)).toBe(
      "look again\n\n[image: shot.png, 12x8]\n[image: shot.png, 12x8]",
    );
    script.reply("seen");
    await sessionSettled(s.app, started.sessionId);
    // moved before the queued row went, so its cascade took none
    const rows = s.ofSession(started.sessionId);
    expect(rows.map((row) => row.id)).toEqual([a.id, b.id]);
    expect(rows.map((row) => [row.queued_id, row.expires_at])).toEqual([
      [null, null],
      [null, null],
    ]);
    const message = s.app.db
      .query<{ id: string }, [string]>(
        "select id from messages where session_id = ? and content = 'look again'",
      )
      .get(started.sessionId)!;
    expect(rows[0]?.message_id).toBe(message.id);
    await s.app.shutdown();
  });

  test("go back to staging under a fresh lease when it is removed", async () => {
    const s = await imageApp();
    const started = await s.start("first", []);
    const a = await s.stage(s.chat.projectId);
    const res = await s.send(started.sessionId, {
      message: "look",
      images: [a.id],
    });
    const { queued } = (await res.json()) as QueuedResponse;
    s.app.now.value += 60_000;
    const removed = await s.chat.member.call(
      "DELETE",
      `/api/sessions/${started.sessionId}/queued/${queued.id}`,
      { body: { revision: queued.revision } },
    );
    expect(removed.status).toBe(200);
    expect(s.image(a.id)).toMatchObject({
      queued_id: null,
      message_id: null,
      expires_at: s.app.now.value + DAY_MS,
    });
    // staged again, so a later message may name it
    const again = await s.send(started.sessionId, {
      message: "look",
      images: [a.id],
    });
    expect(again.status).toBe(202);
    started.script.reply("hi");
    (await s.chat.scripted.reached(2)).reply("seen");
    await sessionSettled(s.app, started.sessionId);
    expect(s.image(a.id)?.session_id).toBe(started.sessionId);
    await s.app.shutdown();
  });

  test("are refused when it is queued for an agent that cannot read them", async () => {
    const s = await imageApp();
    const started = await s.start("first", []);
    s.reads(s.chat.agentId, false);
    const a = await s.stage(s.chat.projectId);
    const res = await s.send(started.sessionId, {
      message: "look",
      images: [a.id],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: CANNOT_READ_IMAGES });
    expect(s.image(a.id)).toMatchObject({ queued_id: null });
    started.script.reply("hi");
    await sessionSettled(s.app, started.sessionId);
    await s.app.shutdown();
  });
});

test("a channel post naming images is refused", async () => {
  const s = await imageApp();
  const channelId = s.app.db
    .query<{ id: string }, [string]>(
      "select id from sessions where project_id = ? and origin = 'channel' and parent_session_id is null",
    )
    .get(s.team.id)!.id;
  const a = await s.stage(s.team.id);
  for (const message of ["look", "@coder look"]) {
    const res = await s.send(channelId, { message, images: [a.id] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: CHANNEL_NO_IMAGES });
  }
  expect(s.image(a.id)).toMatchObject({ message_id: null });
  await s.app.shutdown();
});
