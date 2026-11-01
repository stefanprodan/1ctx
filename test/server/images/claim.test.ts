// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The claim at send: the author's own live staged images in the chat's
// project, the agent that takes the turn, and the project's budget.

import { describe, expect, spyOn, test } from "bun:test";
import { enforceBudget } from "../../../src/server/images/claim.ts";
import {
  CANNOT_READ_IMAGES,
  IMAGE_GONE,
  tooManyImages,
} from "../../../src/server/images/index.ts";
import { FREE_BATCH } from "../../../src/server/images/limits.ts";
import { DAY_MS } from "../../../src/server/lib/clock.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { IMAGE_TITLE } from "../../../src/server/runner/images.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import {
  FLASH,
  NO_TOOLS,
  sessionSettled,
  setLimits,
} from "../../helpers/chat.ts";
import { imageApp, MiB, userTexts } from "./helpers.ts";

const LINE = "[image: shot.png, 12x8]";

describe("the claim at send", () => {
  test("a message takes the author's staged images, and the model reads their lines", async () => {
    const s = await imageApp();
    // no bash: images need no tool
    const plain = await s.chat.makeAgent({ name: "plain", model: NO_TOOLS });
    s.reads(plain);
    const a = await s.stage(s.chat.projectId);
    const b = await s.stage(s.chat.projectId, s.chat.member, "two.png");
    const started = await s.start(
      "look",
      [a.id, b.id],
      s.chat.projectId,
      s.chat.member,
      plain,
    );
    const [first] = (started.detail as SessionDetail).messages;
    expect(first?.images).toEqual([
      {
        id: a.id,
        name: "shot.png",
        mediaType: "image/png",
        width: 12,
        height: 8,
        freed: false,
      },
      {
        id: b.id,
        name: "two.png",
        mediaType: "image/png",
        width: 12,
        height: 8,
        freed: false,
      },
    ]);
    expect(userTexts(started.script)).toEqual([
      `look\n\n${LINE}\n[image: two.png, 12x8]`,
    ]);
    expect(s.ofSession(started.sessionId)).toEqual([
      expect.objectContaining({
        id: a.id,
        message_id: first!.id,
        position: 0,
        expires_at: null,
      }),
      expect.objectContaining({ id: b.id, position: 1, expires_at: null }),
    ]);
    started.script.reply("seen");
    await sessionSettled(s.app, started.sessionId);
    const detail = (await (
      await s.chat.member.call("GET", `/api/sessions/${started.sessionId}`)
    ).json()) as SessionDetail;
    expect(detail.messages[0]?.images?.map((image) => image.id)).toEqual([
      a.id,
      b.id,
    ]);
    expect(detail.messages[1]?.images).toBeUndefined();
    await s.app.shutdown();
  });

  test("a message of images alone keeps empty text, its lines alone on the wire", async () => {
    const s = await imageApp();
    const a = await s.stage(s.chat.projectId);
    const started = await s.start("  ", [a.id]);
    expect(started.detail.session.title).toBe(IMAGE_TITLE);
    expect(started.detail.messages[0].content).toBe("");
    expect(userTexts(started.script)).toEqual([LINE]);
    started.script.reply("seen");
    await sessionSettled(s.app, started.sessionId);
    const blank = await s.send(started.sessionId, { message: " " });
    expect(blank.status).toBe(400);
    await s.app.shutdown();
  });

  test("only the author's own live staged images in the chat's project are claimed", async () => {
    const s = await imageApp();
    const theirs = await s.stage(s.team.id, s.robin);
    const elsewhere = await s.stage(s.chat.projectId);
    const own = await s.stage(s.team.id);
    const sessions = () =>
      s.app.db.query("select count(*) as n from sessions").get();
    const before = sessions();
    for (const ids of [[own.id, theirs.id], [elsewhere.id], ["nosuchimage1"]]) {
      const res = await s.chat.member.call("POST", "/api/sessions", {
        body: {
          projectId: s.team.id,
          agentId: s.chat.agentId,
          message: "look",
          images: ids,
        },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: IMAGE_GONE });
    }
    // a refused start writes nothing, so the images stay staged
    expect(sessions()).toEqual(before);
    for (const image of [own, theirs, elsewhere]) {
      expect(s.image(image.id)).toMatchObject({
        message_id: null,
        expires_at: image.expiresAt,
      });
    }
    // past its lease an image is gone
    s.app.now.value += DAY_MS;
    const late = await s.chat.member.call("POST", "/api/sessions", {
      body: {
        projectId: s.team.id,
        agentId: s.chat.agentId,
        message: "look",
        images: [own.id],
      },
    });
    expect(late.status).toBe(400);
    await s.app.shutdown();
  });

  test("ids never repeat and a message holds at most imagesPerMessage", async () => {
    const s = await imageApp();
    const a = await s.stage(s.chat.projectId);
    const twice = await s.chat.member.call("POST", "/api/sessions", {
      body: {
        projectId: s.chat.projectId,
        agentId: s.chat.agentId,
        message: "look",
        images: [a.id, a.id],
      },
    });
    expect(twice.status).toBe(400);
    await setLimits(s.chat, { imagesPerMessage: 2 });
    const ids = [
      a.id,
      (await s.stage(s.chat.projectId)).id,
      (await s.stage(s.chat.projectId)).id,
    ];
    const over = await s.chat.member.call("POST", "/api/sessions", {
      body: {
        projectId: s.chat.projectId,
        agentId: s.chat.agentId,
        message: "look",
        images: ids,
      },
    });
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({ error: tooManyImages(2) });
    expect(ids.map((id) => s.image(id)?.message_id)).toEqual([
      null,
      null,
      null,
    ]);
    await s.app.shutdown();
  });

  test("a send without images never calls the images area", async () => {
    const s = await imageApp();
    const claim = spyOn(s.app.images, "claim");
    const hold = spyOn(s.app.images, "hold");
    const release = spyOn(s.app.images, "release");
    const sum = spyOn(s.app.images.store, "sentBytes");
    const started = await s.start("hello", []);
    const queued = await s.send(started.sessionId, { message: "later" });
    expect(queued.status).toBe(202);
    const next = s.chat.scripted.reached(2);
    started.script.reply("hi");
    (await next).reply("ok");
    await sessionSettled(s.app, started.sessionId);
    expect([claim, hold, release, sum].map((spy) => spy.mock.calls)).toEqual([
      [],
      [],
      [],
      [],
    ]);
    const a = await s.stage(s.chat.projectId);
    const pending = s.chat.scripted.next();
    expect(
      (await s.send(started.sessionId, { message: "now", images: [a.id] }))
        .status,
    ).toBe(201);
    (await pending).reply("seen");
    await sessionSettled(s.app, started.sessionId);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(sum).toHaveBeenCalledTimes(1);
    await s.app.shutdown();
  });
});

describe("an agent that cannot read images", () => {
  test("refuses the send at the claim, the images left staged", async () => {
    const s = await imageApp();
    s.reads(s.chat.agentId, false);
    const a = await s.stage(s.chat.projectId);
    const res = await s.chat.member.call("POST", "/api/sessions", {
      body: {
        projectId: s.chat.projectId,
        agentId: s.chat.agentId,
        message: "look",
        images: [a.id],
      },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: CANNOT_READ_IMAGES });
    expect(s.image(a.id)).toMatchObject({ message_id: null });
    await s.app.shutdown();
  });

  test("is the summoned agent, whichever the chat's is", async () => {
    const s = await imageApp();
    s.reads(await s.chat.makeAgent({ name: "blind", model: FLASH }), false);
    const seer = await s.chat.makeAgent({ name: "seer", model: FLASH });
    s.reads(seer);
    const started = await s.start("hello", []);
    started.script.reply("hi");
    await sessionSettled(s.app, started.sessionId);
    const a = await s.stage(s.chat.projectId);
    const refused = await s.send(started.sessionId, {
      message: "@blind look",
      images: [a.id],
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: CANNOT_READ_IMAGES });
    // the chat's agent no longer reads images, the summoned one does
    s.reads(s.chat.agentId, false);
    expect(
      (await s.send(started.sessionId, { message: "look", images: [a.id] }))
        .status,
    ).toBe(400);
    const pending = s.chat.scripted.next();
    const summoned = await s.send(started.sessionId, {
      message: "@seer look",
      images: [a.id],
    });
    expect(summoned.status).toBe(201);
    const script = await pending;
    expect(userTexts(script).at(-1)).toBe(`@seer look\n\n${LINE}`);
    script.reply("seen");
    await sessionSettled(s.app, started.sessionId);
    expect(s.image(a.id)?.session_id).toBe(started.sessionId);
    await s.app.shutdown();
  });
});

describe("the project's image budget", () => {
  test("a claim past it frees the oldest sent bytes across chats, archived ones included", async () => {
    const s = await imageApp();
    await setLimits(s.chat, { imageProjectBytes: 256 * MiB });
    const old = await s.stage(s.chat.projectId);
    const archivedChat = await s.start("old", [old.id]);
    archivedChat.script.reply("seen");
    await sessionSettled(s.app, archivedChat.sessionId);
    s.app.sessions.archive(
      archivedChat.sessionId,
      "idle",
      null,
      s.app.now.value,
    );
    const kept = await s.stage(s.chat.projectId);
    const live = await s.start("kept", [kept.id]);
    live.script.reply("seen");
    await sessionSettled(s.app, live.sessionId);
    s.size(old.id, 100 * MiB, 1);
    s.size(kept.id, 100 * MiB, 2);
    // staged bytes are neither counted nor freed
    const waiting = await s.stage(s.chat.projectId);
    s.size(waiting.id, 300 * MiB, 0);
    const fresh = await s.stage(s.chat.projectId);
    s.size(fresh.id, 100 * MiB, 0);
    const pending = s.chat.scripted.next();
    expect(
      (await s.send(live.sessionId, { message: "new", images: [fresh.id] }))
        .status,
    ).toBe(201);
    (await pending).reply("seen");
    await sessionSettled(s.app, live.sessionId);
    // 300 MiB sent: the oldest went, the claim's own older one stayed
    expect(s.image(old.id)).toMatchObject({ freed: 1, bytes: 100 * MiB });
    expect(s.image(kept.id)).toMatchObject({ freed: 0 });
    expect(s.image(fresh.id)).toMatchObject({ freed: 0 });
    expect(s.image(waiting.id)).toMatchObject({ freed: 0, message_id: null });
    const archived = (await (
      await s.chat.member.call("GET", `/api/sessions/${archivedChat.sessionId}`)
    ).json()) as SessionDetail;
    expect(archived.messages[0]?.images?.[0]?.freed).toBe(true);
    await s.app.shutdown();
  });

  test("never frees the claim's own images, and a lowered budget frees at the next claim", async () => {
    const s = await imageApp();
    const a = await s.stage(s.chat.projectId);
    const b = await s.stage(s.chat.projectId);
    const started = await s.start("two", [a.id, b.id]);
    started.script.reply("seen");
    await sessionSettled(s.app, started.sessionId);
    s.size(a.id, 200 * MiB, 1);
    s.size(b.id, 200 * MiB, 2);
    await setLimits(s.chat, { imageProjectBytes: 256 * MiB });
    // a lowered budget waits for a claim
    expect([s.image(a.id)?.freed, s.image(b.id)?.freed]).toEqual([0, 0]);
    const big = await s.stage(s.chat.projectId);
    s.size(big.id, 300 * MiB, 0);
    const pending = s.chat.scripted.next();
    expect(
      (await s.send(started.sessionId, { message: "big", images: [big.id] }))
        .status,
    ).toBe(201);
    (await pending).reply("seen");
    await sessionSettled(s.app, started.sessionId);
    // over by 444 MiB: both older ones went, the claim's own stayed
    expect([a, b, big].map((one) => s.image(one.id)?.freed)).toEqual([1, 1, 0]);
    await s.app.shutdown();
  });

  test("frees at most a batch a call", async () => {
    const s = await imageApp();
    const a = await s.stage(s.chat.projectId);
    const started = await s.start("one", [a.id]);
    started.script.reply("seen");
    await sessionSettled(s.app, started.sessionId);
    const message = s.image(a.id)!;
    const insert = s.app.db.query(
      `insert into images (id, project_id, user_id, session_id, message_id,
         position, name, media_type, bytes, width, height, digest, created_at,
         data)
       values (?, ?, ?, ?, ?, ?, 'a.png', 'image/png', ?, 1, 1, 'd', ?, x'01')`,
    );
    const rows = FREE_BATCH + 44;
    for (let i = 0; i < rows; i++) {
      insert.run(
        `bulk${String(i).padStart(8, "0")}`,
        s.chat.projectId,
        s.chat.memberId,
        started.sessionId,
        message.message_id,
        i + 1,
        10 * MiB,
        10 + i,
      );
    }
    const deps = {
      store: s.app.images.store,
      caps: () => ({ ...DEFAULT_LIMITS, imageProjectBytes: 256 * MiB }),
      now: () => s.app.now.value,
    };
    // 3,000 MiB over 256 needs 275 rows: a batch now, the rest next
    expect(enforceBudget(deps, s.chat.projectId, new Set())).toBe(FREE_BATCH);
    expect(enforceBudget(deps, s.chat.projectId, new Set())).toBe(
      275 - FREE_BATCH,
    );
    expect(enforceBudget(deps, s.chat.projectId, new Set())).toBe(0);
    const freed = s.app.db
      .query<{ n: number }, []>(
        "select count(*) as n from images where data is null",
      )
      .get()!.n;
    expect(freed).toBe(275);
    // the oldest went first
    expect(s.image("bulk00000000")?.freed).toBe(1);
    expect(s.image(`bulk${String(rows - 1).padStart(8, "0")}`)?.freed).toBe(0);
    await s.app.shutdown();
  });
});
