// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The check at the start, the summary imagesPerRequest makes due, and
// the history to an agent that does not read images.

import { describe, expect, test } from "bun:test";
import { SUMMARIZE } from "../../../src/server/runner/context.ts";
import {
  IMAGE_DUE_BYTES,
  imagesFit,
  NO_IMAGE_ROOM,
} from "../../../src/shared/images.ts";
import { sessionSettled, setLimits } from "../../helpers/chat.ts";
import { imageApp, MiB, userTexts } from "./helpers.ts";

const LINE = "[image: shot.png, 12x8]";

describe("a request's images", () => {
  test("a message past imagesPerRequest is refused and its images stay staged", async () => {
    const s = await imageApp();
    await setLimits(s.chat, { imagesPerMessage: 2, imagesPerRequest: 2 });
    const a = await s.stage(s.chat.projectId);
    const started = await s.start("look", [a.id]);
    started.script.reply("seen");
    await sessionSettled(s.app, started.sessionId);
    const b = await s.stage(s.chat.projectId);
    const c = await s.stage(s.chat.projectId);
    const refused = await s.send(started.sessionId, {
      message: "and these",
      images: [b.id, c.id],
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: imagesFit(1, 2) });
    expect(imagesFit(1, 2)).toBe("only 1 of these 2 images fit in this chat");
    for (const id of [b.id, c.id]) {
      expect(s.image(id)).toMatchObject({
        message_id: null,
        expires_at: expect.any(Number),
      });
    }
    // nothing was written
    const detail = await (
      await s.chat.member.call("GET", `/api/sessions/${started.sessionId}`)
    ).json();
    expect(detail.messages).toHaveLength(2);
    await s.app.shutdown();
  });

  test("a request that carried imagesPerRequest makes the summary due, which reads them", async () => {
    const s = await imageApp();
    await setLimits(s.chat, { imagesPerMessage: 2, imagesPerRequest: 2 });
    const a = await s.stage(s.chat.projectId);
    const b = await s.stage(s.chat.projectId);
    const started = await s.start("look", [a.id, b.id]);
    const summary = s.chat.scripted.reached(2);
    started.script.reply("seen");
    const round = await summary;
    const last = (round.body.messages as { content: unknown }[]).at(-1);
    expect(last?.content).toBe(SUMMARIZE);
    expect(userTexts(round)[0]).toBe("look\n<image/png>\n<image/png>");
    round.reply("a summary");
    await sessionSettled(s.app, started.sessionId);
    // the tail replays at most one image, so the next has room
    const c = await s.stage(s.chat.projectId);
    const next = s.chat.scripted.next();
    const sent = await s.send(started.sessionId, {
      message: "one more",
      images: [c.id],
    });
    expect(sent.status).toBe(201);
    const script = await next;
    expect(userTexts(script).at(-1)).toBe("one more\n<image/png>");
    script.reply("seen");
    await sessionSettled(s.app, started.sessionId);
    await s.app.shutdown();
  });

  test("a message past the byte bound is refused with how many fit", async () => {
    const s = await imageApp();
    const a = await s.stage(s.chat.projectId);
    s.size(a.id, 8 * MiB);
    const started = await s.start("look", [a.id]);
    started.script.reply("seen");
    await sessionSettled(s.app, started.sessionId);
    const b = await s.stage(s.chat.projectId);
    const c = await s.stage(s.chat.projectId);
    s.size(b.id, 3 * MiB);
    s.size(c.id, 3 * MiB);
    const refused = await s.send(started.sessionId, {
      message: "and these",
      images: [b.id, c.id],
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: imagesFit(1, 2) });
    expect(s.image(b.id)?.message_id).toBeNull();
    await s.app.shutdown();
  });

  test("a history past the due bytes makes the summary due, and it fits", async () => {
    const s = await imageApp();
    const a = await s.stage(s.chat.projectId);
    const b = await s.stage(s.chat.projectId);
    s.size(a.id, 5 * MiB);
    s.size(b.id, 5 * MiB);
    expect(10 * MiB).toBeGreaterThan(IMAGE_DUE_BYTES);
    const started = await s.start("look", [a.id, b.id]);
    const summary = s.chat.scripted.reached(2);
    started.script.reply("seen");
    const round = await summary;
    const last = (round.body.messages as { content: unknown }[]).at(-1);
    expect(last?.content).toBe(SUMMARIZE);
    // under the request bound, the summary reads them as parts
    expect(userTexts(round)[0]).toBe("look\n<image/png>\n<image/png>");
    round.reply("a summary");
    await sessionSettled(s.app, started.sessionId);
    // the turn's 10 MiB pass the tail's half, so the next has room
    const c = await s.stage(s.chat.projectId);
    s.size(c.id, 6 * MiB);
    const next = s.chat.scripted.next();
    const sent = await s.send(started.sessionId, {
      message: "one more",
      images: [c.id],
    });
    expect(sent.status).toBe(201);
    const script = await next;
    expect(userTexts(script).filter((text) => text.includes("<image"))).toEqual(
      ["one more\n<image/png>"],
    );
    script.reply("seen");
    await sessionSettled(s.app, started.sessionId);
    await s.app.shutdown();
  });

  test("history to an agent that does not read images is their lines", async () => {
    const s = await imageApp();
    const a = await s.stage(s.chat.projectId);
    const started = await s.start("look", [a.id]);
    started.script.reply("seen");
    await sessionSettled(s.app, started.sessionId);
    s.reads(s.chat.agentId, false);
    const next = s.chat.scripted.next();
    const sent = await s.send(started.sessionId, { message: "and now?" });
    expect(sent.status).toBe(201);
    const script = await next;
    expect(userTexts(script)).toEqual([`look\n\n${LINE}`, "and now?"]);
    script.reply("done");
    await sessionSettled(s.app, started.sessionId);
    await s.app.shutdown();
  });

  test("the words say how many fit, none when the history is the cause", () => {
    expect(imagesFit(0, 3)).toBe(NO_IMAGE_ROOM);
    expect(imagesFit(2, 3)).toBe("only 2 of these 3 images fit in this chat");
  });
});
