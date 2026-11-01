// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { FREED } from "../../../src/server/images/index.ts";
import { MAX_STAGED_IMAGES } from "../../../src/server/images/limits.ts";
import { HEIC_REFUSED, SVG_REFUSED } from "../../../src/server/images/sniff.ts";
import {
  TOO_MANY_STAGED,
  tooLarge,
  tooMany,
} from "../../../src/server/images/stage.ts";
import { DAY_MS, HOUR_MS } from "../../../src/server/lib/clock.ts";
import type { StagedImage } from "../../../src/shared/api/images.ts";
import { hashPassword } from "../../helpers/app.ts";
import {
  type ChatApp,
  chatApp,
  sessionSettled,
  setLimits,
  startChat,
} from "../../helpers/chat.ts";
import { png } from "../../helpers/images.ts";

type Client = ChatApp["member"];

const tiny = (shade = 0) => png(12, 8, (x) => [x < 6 ? 255 : shade, 0, 0, 255]);

async function setup() {
  const chat = await chatApp();
  const { app } = chat;
  const robin = app.createUser({
    username: "robin",
    fullName: "Robin Roe",
    email: "robin@example.com",
    role: "member",
    passwordHash: await hashPassword("pw2"),
    mustChangePassword: false,
    now: app.now.value,
  });
  const other = app.client();
  await other.login("robin", "pw2");
  const team = app.projects.createTeam({
    ownerId: chat.memberId,
    name: "shared",
    description: "",
    now: app.now.value,
  });
  app.projects.addMember(team.id, chat.memberId, app.now.value);
  app.projects.addMember(team.id, robin.id, app.now.value);
  const post = (
    client: Client,
    projectId: string,
    bytes: Uint8Array<ArrayBuffer>,
    options: { name?: string; type?: string } = {},
  ) =>
    client.call(
      "POST",
      `/api/projects/${projectId}/images${options.name === undefined ? "" : `?name=${encodeURIComponent(options.name)}`}`,
      {
        bytes,
        headers: { "content-type": options.type ?? "application/octet-stream" },
      },
    );
  const stage = async (projectId = team.id, bytes = tiny()) => {
    const res = await post(chat.member, projectId, bytes, { name: "shot.png" });
    expect(res.status).toBe(201);
    return ((await res.json()) as { image: StagedImage }).image;
  };
  const get = (
    client: Client,
    projectId: string,
    imageId: string,
    headers: Record<string, string> = {},
  ) =>
    client.call("GET", `/api/projects/${projectId}/images/${imageId}`, {
      headers,
    });
  // a sent image, as the claim at send will leave it
  const send = (imageId: string, sessionId: string, messageId: string) =>
    app.db
      .query(
        `update images set session_id = ?, message_id = ?, expires_at = null
         where id = ?`,
      )
      .run(sessionId, messageId, imageId);
  // a chat in the team with its first user message
  const teamChat = async () => {
    const { script, sessionId } = await startChat(
      chat,
      "look",
      chat.member,
      team.id,
    );
    script.reply("seen");
    await sessionSettled(app, sessionId);
    const { id } = app.db
      .query<{ id: string }, [string]>(
        "select id from messages where session_id = ? and kind = 'user'",
      )
      .get(sessionId)!;
    return { sessionId, messageId: id };
  };
  return { chat, app, other, team, post, stage, get, send, teamChat };
}

test("stages an image from its bytes, whatever the client calls it", async () => {
  const s = await setup();
  const res = await s.post(s.chat.member, s.team.id, tiny(), {
    name: "photos/shot.jpeg",
    type: "image/jpeg",
  });
  expect(res.status).toBe(201);
  const { image } = (await res.json()) as { image: StagedImage };
  expect(image).toEqual({
    id: expect.any(String),
    name: "shot.png",
    mediaType: "image/png",
    bytes: expect.any(Number),
    width: 12,
    height: 8,
    expiresAt: s.app.now.value + DAY_MS,
  });
  const svg = new TextEncoder().encode("<svg onload='x()'/>");
  const refused = await s.post(s.chat.member, s.team.id, svg, {
    type: "image/png",
  });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: SVG_REFUSED });
  const heic = new Uint8Array([
    0,
    0,
    0,
    24,
    ...new TextEncoder().encode("ftypheic"),
    0,
    0,
    0,
    0,
  ]);
  const heicRes = await s.post(s.chat.member, s.team.id, heic, {
    type: "image/heic",
  });
  expect(await heicRes.json()).toEqual({ error: HEIC_REFUSED });
});

test("a staged image is its uploader's alone, and goes with its delete", async () => {
  const s = await setup();
  const image = await s.stage();
  expect((await s.get(s.chat.member, s.team.id, image.id)).status).toBe(200);
  for (const client of [s.other, s.chat.admin]) {
    const res = await s.get(client, s.team.id, image.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such image" });
    const removed = await client.call(
      "DELETE",
      `/api/projects/${s.team.id}/images/${image.id}`,
    );
    expect(removed.status).toBe(404);
  }
  // another project's id is the same 404
  expect((await s.get(s.chat.member, s.chat.projectId, image.id)).status).toBe(
    404,
  );
  const removed = await s.chat.member.call(
    "DELETE",
    `/api/projects/${s.team.id}/images/${image.id}`,
  );
  expect(removed.status).toBe(204);
  expect((await s.get(s.chat.member, s.team.id, image.id)).status).toBe(404);
  expect(s.app.images.store.byId(image.id)).toBeNull();
});

test("the bytes carry the serving headers, and a 304 comes only after access", async () => {
  const s = await setup();
  const image = await s.stage();
  const res = await s.get(s.chat.member, s.team.id, image.id);
  const digest = s.app.images.store.byId(image.id)!.digest;
  expect(Object.fromEntries(res.headers)).toMatchObject({
    "content-type": "image/png",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "content-disposition": `inline; filename="shot.png"; filename*=UTF-8''shot.png`,
    "cross-origin-resource-policy": "same-origin",
    "cache-control": "private, no-cache",
    etag: `"${digest}"`,
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(bytes.length).toBe(image.bytes);
  expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(
    digest,
  );
  const tagged = { "if-none-match": `W/"other", "${digest}"` };
  const cached = await s.get(s.chat.member, s.team.id, image.id, tagged);
  expect(cached.status).toBe(304);
  expect(await cached.text()).toBe("");
  expect(cached.headers.get("etag")).toBe(`"${digest}"`);
  expect((await s.get(s.other, s.team.id, image.id, tagged)).status).toBe(404);
  const stale = { "if-none-match": `"other"` };
  expect((await s.get(s.chat.member, s.team.id, image.id, stale)).status).toBe(
    200,
  );
});

test("a sent image follows its chat, and freed bytes answer 410", async () => {
  const s = await setup();
  const image = await s.stage();
  const { sessionId, messageId } = await s.teamChat();
  s.send(image.id, sessionId, messageId);
  for (const client of [s.chat.member, s.other, s.chat.admin]) {
    expect((await s.get(client, s.team.id, image.id)).status).toBe(200);
  }
  s.app.createUser({
    username: "sam",
    fullName: "Sam",
    email: "sam@example.com",
    role: "member",
    passwordHash: await hashPassword("pw3"),
    mustChangePassword: false,
    now: s.app.now.value,
  });
  const sam = s.app.client();
  await sam.login("sam", "pw3");
  expect((await s.get(sam, s.team.id, image.id)).status).toBe(404);
  // a sent image is no longer staged, so its uploader cannot remove it
  const removed = await s.chat.member.call(
    "DELETE",
    `/api/projects/${s.team.id}/images/${image.id}`,
  );
  expect(removed.status).toBe(404);
  s.app.db.query("update images set data = null where id = ?").run(image.id);
  const freed = await s.get(s.other, s.team.id, image.id);
  expect(freed.status).toBe(410);
  expect(await freed.json()).toEqual({ error: FREED });
  expect((await s.get(sam, s.team.id, image.id)).status).toBe(404);
  // the row keeps what the page shows in its place
  expect(s.app.images.store.byId(image.id)).toMatchObject({
    name: "shot.png",
    width: 12,
    height: 8,
    freed: true,
  });
});

test("images go with their message, chat and project", async () => {
  const s = await setup();
  const { sessionId, messageId } = await s.teamChat();
  const [a, b, c] = [await s.stage(), await s.stage(), await s.stage()];
  for (const image of [a!, b!]) s.send(image.id, sessionId, messageId);
  const ids = () =>
    s.app.db
      .query<{ id: string }, []>("select id from images order by id")
      .all()
      .map((row) => row.id);
  expect(ids()).toHaveLength(3);
  s.app.db.query("delete from messages where id = ?").run(messageId);
  expect(ids()).toEqual([c!.id]);
  const second = await s.teamChat();
  const d = await s.stage();
  s.send(d.id, second.sessionId, second.messageId);
  s.app.db.query("delete from sessions where id = ?").run(second.sessionId);
  expect(ids()).toEqual([c!.id]);
  s.app.db.query("delete from projects where id = ?").run(s.team.id);
  expect(ids()).toEqual([]);
});

test("the lease sweep removes expired staged images and never a sent one", async () => {
  const s = await setup();
  const staged = await s.stage();
  const sent = await s.stage();
  const { sessionId, messageId } = await s.teamChat();
  s.send(sent.id, sessionId, messageId);
  s.app.now.value += DAY_MS;
  // expired is gone to its uploader before the sweep removes it
  expect((await s.get(s.chat.member, s.team.id, staged.id)).status).toBe(404);
  expect(s.app.images.sweep(s.app.now.value)).toBe(1);
  expect(s.app.images.store.byId(staged.id)).toBeNull();
  expect(s.app.images.store.byId(sent.id)).not.toBeNull();
  expect(s.app.images.sweep(s.app.now.value + DAY_MS)).toBe(0);
});

test("a body past the byte cap is a 413", async () => {
  const s = await setup();
  await setLimits(s.chat, { imageUploadBytes: 1024 * 1024 });
  const big = new Uint8Array(1024 * 1024 + 1);
  big.set(tiny());
  const res = await s.post(s.chat.member, s.team.id, big);
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: tooLarge(1024 * 1024) });
});

test("the hourly rate refuses past its limit and frees an hour later", async () => {
  const s = await setup();
  await setLimits(s.chat, { imagesPerHour: 10 });
  for (let i = 0; i < 10; i++) {
    await s.stage();
    s.app.now.value += 1000;
  }
  const refused = await s.post(s.chat.member, s.team.id, tiny());
  expect(refused.status).toBe(429);
  expect(await refused.json()).toEqual({ error: tooMany(10) });
  // the first one leaves the window 3,600 s after it was added
  expect(refused.headers.get("retry-after")).toBe(String(3600 - 10));
  // the rate is the user's own, not the project's
  expect((await s.post(s.other, s.team.id, tiny())).status).toBe(201);
  s.app.now.value += HOUR_MS - 10_000;
  expect((await s.post(s.chat.member, s.team.id, tiny())).status).toBe(201);
});

test("a user may hold a bounded number of staged images", async () => {
  const s = await setup();
  for (let i = 0; i < MAX_STAGED_IMAGES; i++) await s.stage();
  const refused = await s.post(s.chat.member, s.team.id, tiny());
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: TOO_MANY_STAGED });
});
