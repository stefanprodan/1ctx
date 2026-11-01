// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Storage monitor counts a chat's images where it counts its
// uploads.

import { expect, test } from "bun:test";
import { scan } from "../../../src/server/overview/scan.ts";
import { sessionSettled } from "../../helpers/chat.ts";
import { imageApp } from "./helpers.ts";

test("a chat's sent images count with its uploads, staged ones as staging", async () => {
  const s = await imageApp();
  const sent = await s.stage(s.chat.projectId);
  const started = await s.start("look", [sent.id]);
  started.script.reply("seen");
  await sessionSettled(s.app, started.sessionId);
  const waiting = await s.stage(s.chat.projectId);
  const read = () => scan(s.app.db, { now: s.app.now.value, since: 0 });
  const slotBytes = (result: ReturnType<typeof read>) =>
    result.slots.reduce((sum, slot) => sum + slot[1], 0);
  const before = read();
  expect(
    before.sessions.find((row) => row.id === started.sessionId)?.uploadBytes,
  ).toBe(sent.bytes);
  expect(before.staging).toBe(waiting.bytes);
  // a freed image holds no bytes, so it leaves every sum
  s.app.db.query("update images set data = null where id = ?").run(sent.id);
  const after = read();
  expect(
    after.sessions.find((row) => row.id === started.sessionId)?.uploadBytes,
  ).toBe(0);
  expect(slotBytes(before) - slotBytes(after)).toBe(sent.bytes);
  await s.app.shutdown();
});
