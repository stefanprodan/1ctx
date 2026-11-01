// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Fork copies a chat's images, a fork at a user turn stages its images
// for the draft, regenerate keeps them, and every text reader of a
// message says one line per image.

import { describe, expect, test } from "bun:test";
import { MAX_STAGED_IMAGES } from "../../../src/server/images/limits.ts";
import { envelopeRow } from "../../../src/server/sessions/feed.ts";
import type {
  ForkSessionResponse,
  SessionsResponse,
} from "../../../src/shared/api/sessions.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { sessionSettled, setLimits } from "../../helpers/chat.ts";
import { type ImageApp, imageApp, MiB, userTexts } from "./helpers.ts";

// a chat of two turns: one with images a (freed) and b, two with c
async function twoTurns(s: ImageApp, projectId = s.chat.projectId) {
  const a = await s.stage(projectId, s.chat.member, "a.png");
  const b = await s.stage(projectId, s.chat.member, "b.png");
  const one = await s.start("one", [a.id, b.id], projectId);
  one.script.reply("first");
  await sessionSettled(s.app, one.sessionId);
  const c = await s.stage(projectId, s.chat.member, "c.png");
  const pending = s.chat.scripted.next();
  expect(
    (await s.send(one.sessionId, { message: "two", images: [c.id] })).status,
  ).toBe(201);
  (await pending).reply("second");
  await sessionSettled(s.app, one.sessionId);
  s.app.db.query("update images set data = null where id = ?").run(a.id);
  const rows = s.app.sessions.messages(one.sessionId);
  return { sessionId: one.sessionId, rows, a, b, c };
}

async function fork(
  s: ImageApp,
  sessionId: string,
  messageId: string,
  client = s.chat.member,
): Promise<ForkSessionResponse> {
  const res = await client.call("POST", `/api/sessions/${sessionId}/fork`, {
    body: { messageId, agentId: s.chat.agentId },
  });
  expect(res.status).toBe(201);
  return res.json();
}

describe("fork", () => {
  test("copies every copied user message's images, freed ones staying freed", async () => {
    const s = await imageApp();
    const { sessionId, rows, a, b, c } = await twoTurns(s);
    const answer = rows.filter((row) => row.slot === "answer").at(-1)!;
    const copied = await fork(s, sessionId, answer.id);
    expect(copied.draftImages).toEqual([]);
    const users = copied.messages.filter((row) => row.kind === "user");
    expect(
      users.map((row) =>
        row.images?.map(({ name, freed }) => ({ name, freed })),
      ),
    ).toEqual([
      [
        { name: "a.png", freed: true },
        { name: "b.png", freed: false },
      ],
      [{ name: "c.png", freed: false }],
    ]);
    const copies = s.ofSession(copied.session.id);
    expect(copies).toHaveLength(3);
    for (const copy of copies) {
      expect([a.id, b.id, c.id]).not.toContain(copy.id);
      expect(copy.expires_at).toBeNull();
    }
    expect(copies.map((copy) => copy.freed)).toEqual([1, 0, 0]);
    // the source keeps its own
    expect(s.ofSession(sessionId).map((row) => row.id)).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
    const detail = (await (
      await s.chat.member.call("GET", `/api/sessions/${copied.session.id}`)
    ).json()) as SessionDetail;
    expect(detail.messages.filter((row) => row.images).length).toBe(2);
    await s.app.shutdown();
  });

  test("at a user turn stages its images for the user forking, a freed one left out", async () => {
    const s = await imageApp();
    const { sessionId, rows } = await twoTurns(s, s.team.id);
    const [first, second] = rows.filter((row) => row.kind === "user");
    const atSecond = await fork(s, sessionId, second!.id, s.robin);
    expect(atSecond.draftImages).toEqual([
      expect.objectContaining({
        name: "c.png",
        expiresAt: s.app.now.value + 86_400_000,
      }),
    ]);
    const draft = atSecond.draftImages[0]!;
    expect(s.image(draft.id)).toMatchObject({
      user_id: s.robinId,
      message_id: null,
      queued_id: null,
    });
    // the copied first turn holds its own copies
    expect(s.ofSession(atSecond.session.id)).toHaveLength(2);
    // the draft sends them
    const pending = s.chat.scripted.next();
    const sent = await s.send(
      atSecond.session.id,
      { message: "two", images: [draft.id] },
      s.robin,
    );
    expect(sent.status).toBe(201);
    const script = await pending;
    expect(userTexts(script)).toEqual([
      "one\n\n[image removed: a.png, 12x8]\n<image/png>",
      "two\n<image/png>",
    ]);
    script.reply("again");
    await sessionSettled(s.app, atSecond.session.id);
    const atFirst = await fork(s, sessionId, first!.id, s.robin);
    expect(atFirst.draftImages.map((image) => image.name)).toEqual(["b.png"]);
    await s.app.shutdown();
  });

  test("stages no more draft images than the user's room under the staged cap", async () => {
    const s = await imageApp();
    const { sessionId, rows } = await twoTurns(s, s.team.id);
    const [first, second] = rows.filter((row) => row.kind === "user");
    for (let i = 0; i < MAX_STAGED_IMAGES - 1; i++) {
      await s.stage(s.team.id, s.robin);
    }
    const staged = () =>
      s.app.images.store.stagedCount(s.robinId, s.app.now.value);
    // one place left: the second turn's one image takes it
    const atSecond = await fork(s, sessionId, second!.id, s.robin);
    expect(atSecond.draftImages.map((image) => image.name)).toEqual(["c.png"]);
    expect(staged()).toBe(MAX_STAGED_IMAGES);
    // none left: the first turn's live image is left out
    const atFirst = await fork(s, sessionId, first!.id, s.robin);
    expect(atFirst.draftImages).toEqual([]);
    expect(staged()).toBe(MAX_STAGED_IMAGES);
    await s.app.shutdown();
  });

  test("copies count against the budget, never freeing themselves", async () => {
    const s = await imageApp();
    const { sessionId, rows, b, c } = await twoTurns(s);
    await setLimits(s.chat, { imageProjectBytes: 256 * MiB });
    s.size(b.id, 100 * MiB, 1);
    s.size(c.id, 50 * MiB, 2);
    const answer = rows.filter((row) => row.slot === "answer").at(-1)!;
    const copied = await fork(s, sessionId, answer.id);
    // 300 MiB with the copies: the oldest original went
    expect(s.image(b.id)?.freed).toBe(1);
    expect(s.image(c.id)?.freed).toBe(0);
    expect(
      s.ofSession(copied.session.id).map((row) => [row.bytes, row.freed]),
    ).toEqual([
      [expect.any(Number), 1],
      [100 * MiB, 0],
      [50 * MiB, 0],
    ]);
    await s.app.shutdown();
  });
});

describe("regenerate", () => {
  test("keeps the message's images and sends them again", async () => {
    const s = await imageApp();
    const a = await s.stage(s.chat.projectId);
    const started = await s.start("look", [a.id]);
    started.script.reply("seen");
    await sessionSettled(s.app, started.sessionId);
    const pending = s.chat.scripted.next();
    const res = await s.chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/regenerate`,
      { body: {} },
    );
    expect(res.status).toBe(201);
    const script = await pending;
    expect(userTexts(script)).toEqual(["look\n<image/png>"]);
    script.reply("again");
    await sessionSettled(s.app, started.sessionId);
    expect(s.ofSession(started.sessionId).map((row) => row.id)).toEqual([a.id]);
    await s.app.shutdown();
  });
});

describe("image lines", () => {
  test("the Markdown download says each image, removed ones too", async () => {
    const s = await imageApp();
    const { sessionId } = await twoTurns(s);
    const res = await s.chat.member.call(
      "GET",
      `/api/sessions/${sessionId}/markdown?tz=UTC`,
    );
    const text = await res.text();
    expect(text).toContain(
      "one\n\n\\[image removed: a.png, 12x8\\]\n\n\\[image: b.png, 12x8\\]",
    );
    expect(text).toContain("two\n\n\\[image: c.png, 12x8\\]");
    await s.app.shutdown();
  });

  test("a message of images alone is the feed's line, in the list and the envelope", async () => {
    const s = await imageApp();
    const a = await s.stage(s.chat.projectId, s.chat.member, "pod.png");
    const started = await s.start("", [a.id]);
    const res = await s.chat.member.call(
      "GET",
      `/api/sessions?project=${s.chat.projectId}`,
    );
    const { rows } = (await res.json()) as SessionsResponse;
    const row = rows.find((one) => one.session.id === started.sessionId)!;
    expect(row.last?.text).toBe("[image: pod.png, 12x8]");
    expect(envelopeRow(s.app.db, started.sessionId)?.last).toEqual(row.last);
    started.script.reply("seen");
    await sessionSettled(s.app, started.sessionId);
    await s.app.shutdown();
  });
});
