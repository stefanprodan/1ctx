// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A queued message holds its images until its turn takes them; the
// channel takes none.

import { describe, expect, test } from "bun:test";
import { CANNOT_READ_IMAGES } from "../../../src/server/images/index.ts";
import { MAX_STAGED_IMAGES } from "../../../src/server/images/limits.ts";
import { TOO_MANY_STAGED } from "../../../src/server/images/stage.ts";
import { DAY_MS } from "../../../src/server/lib/clock.ts";
import { CHANNEL_NO_IMAGES } from "../../../src/server/runner/channel.ts";
import type {
  NotSentResponse,
  QueuedResponse,
  QueuedRowResponse,
} from "../../../src/shared/api/sessions.ts";
import { FLASH, sessionSettled } from "../../helpers/chat.ts";
import { png } from "../../helpers/images.ts";
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

  test("count toward the staged cap once released, however old, and may pass it", async () => {
    const s = await imageApp();
    const started = await s.start("first", []);
    const held = await s.stage(s.chat.projectId);
    const res = await s.send(started.sessionId, {
      message: "look",
      images: [held.id],
    });
    const { queued } = (await res.json()) as QueuedResponse;
    // the row outlives a lease, kept as not sent with its images
    s.app.now.value += 2 * DAY_MS;
    for (let i = 0; i < MAX_STAGED_IMAGES; i++) {
      await s.stage(s.chat.projectId);
    }
    const shown = await s.chat.member.call(
      "GET",
      `/api/sessions/${started.sessionId}/queued/${queued.id}`,
    );
    const row = ((await shown.json()) as QueuedRowResponse).queued;
    expect(row).toMatchObject({ state: "not-sent", images: 1 });
    const removed = await s.chat.member.call(
      "DELETE",
      `/api/sessions/${started.sessionId}/queued/${queued.id}`,
      { body: { revision: row.revision } },
    );
    expect(removed.status).toBe(200);
    expect(
      s.app.images.store.stagedCount(s.chat.memberId, s.app.now.value),
    ).toBe(MAX_STAGED_IMAGES + 1);
    const refused = await s.chat.member.call(
      "POST",
      `/api/projects/${s.chat.projectId}/images`,
      {
        bytes: png(2, 2, () => [0, 0, 0, 255]),
        headers: { "content-type": "application/octet-stream" },
      },
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: TOO_MANY_STAGED });
    started.script.reply("hi");
    await sessionSettled(s.app, started.sessionId);
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

  test("are refused when an edit summons an agent that cannot read them", async () => {
    const s = await imageApp();
    const blind = await s.chat.makeAgent({ name: "blind", model: FLASH });
    s.reads(blind, false);
    const started = await s.start("first", []);
    const a = await s.stage(s.chat.projectId);
    const res = await s.send(started.sessionId, {
      message: "look",
      images: [a.id],
    });
    expect(res.status).toBe(202);
    const { queued } = (await res.json()) as QueuedResponse;
    const edited = await s.chat.member.call(
      "PATCH",
      `/api/sessions/${started.sessionId}/queued/${queued.id}`,
      { body: { message: "@blind look", revision: queued.revision } },
    );
    expect(edited.status).toBe(400);
    expect(await edited.json()).toEqual({ error: CANNOT_READ_IMAGES });
    // the row and its images are as they were
    const row = await s.chat.member.call(
      "GET",
      `/api/sessions/${started.sessionId}/queued/${queued.id}`,
    );
    expect(await row.json()).toMatchObject({
      queued: { text: "look", revision: queued.revision },
    });
    expect(s.image(a.id)?.queued_id).toBe(queued.id);
    const next = s.chat.scripted.reached(2);
    started.script.reply("hi");
    (await next).reply("seen");
    await sessionSettled(s.app, started.sessionId);
    expect(s.image(a.id)?.session_id).toBe(started.sessionId);
    await s.app.shutdown();
  });
});

test("a queued message of images alone says its first image on Home's not-sent list", async () => {
  const s = await imageApp();
  const started = await s.start("first", []);
  const a = await s.stage(s.chat.projectId, s.chat.member, "pod.png");
  expect(
    (await s.send(started.sessionId, { message: "", images: [a.id] })).status,
  ).toBe(202);
  // the agent stops reading images, so the start refuses the row
  s.reads(s.chat.agentId, false);
  started.script.reply("hi");
  await sessionSettled(s.app, started.sessionId);
  const res = await s.chat.member.call("GET", "/api/me/not-sent");
  const { rows } = (await res.json()) as NotSentResponse;
  expect(rows.map(({ line, reason }) => ({ line, reason }))).toEqual([
    { line: "[image: pod.png, 12x8]", reason: "failed" },
  ]);
  expect(s.image(a.id)?.queued_id).toBe(rows[0]!.id);
  await s.app.shutdown();
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
