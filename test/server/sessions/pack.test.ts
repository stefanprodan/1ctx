// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, spyOn, test } from "bun:test";
import { PACK_FROM } from "../../../src/server/sessions/pack.ts";
import type { ForkSessionResponse } from "../../../src/shared/api/sessions.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { collectLogs } from "../../helpers/app.ts";
import {
  createAutomation,
  settleRun as settle,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";

// over the threshold in bytes, under it in characters, so a count of
// UTF-16 units would miss it
const BIG = "résumé 🕰️ line of a long tool result\n".repeat(
  Math.ceil(PACK_FROM / 40),
);

const call = (id: string) => ({
  id,
  name: "datetime",
  arguments: '{"timezone":"UTC"}',
});

type Stored = {
  id: string;
  content: string;
  packed: Uint8Array | null;
  packed_bytes: number | null;
};

function toolRows(chat: ChatApp, sessionId: string): Stored[] {
  return chat.app.db
    .query<Stored, [string]>(
      `select id, content, packed, packed_bytes from messages
       where session_id = ? and kind = 'tool' order by seq`,
    )
    .all(sessionId);
}

// the first tool row's result made large, as a real command's can be
function enlarge(chat: ChatApp, sessionId: string): string {
  const [row] = toolRows(chat, sessionId);
  chat.app.db
    .query("update messages set content = ? where id = ?")
    .run(BIG, row!.id);
  return row!.id;
}

// a chat whose first round calls two tools and whose second answers;
// the second round's script is handed back unanswered
async function toolChat(chat: ChatApp): Promise<{
  sessionId: string;
  answer: Script;
}> {
  const started = await startChat(chat, "what time is it");
  started.script.content("Checking.");
  started.script.toolRound([call("t1"), call("t2")]);
  started.script.end();
  return {
    sessionId: started.sessionId,
    answer: await waitScript(chat.scripted, 2),
  };
}

async function get(chat: ChatApp, path: string) {
  const res = await chat.member.call("GET", path);
  expect(res.status).toBe(200);
  return res;
}

async function result(chat: ChatApp, sessionId: string, messageId: string) {
  return (
    await get(chat, `/api/sessions/${sessionId}/messages/${messageId}/result`)
  ).json();
}

async function fork(chat: ChatApp, sessionId: string, messageId: string) {
  const res = await chat.member.call(
    "POST",
    `/api/sessions/${sessionId}/fork`,
    {
      body: { messageId, agentId: chat.agentId },
    },
  );
  expect(res.status).toBe(201);
  return (await res.json()) as ForkSessionResponse;
}

// a turn in the fork, and the tool results its request carried
async function forkContext(chat: ChatApp, forkId: string) {
  const pending = chat.scripted.next();
  const res = await chat.member.call(
    "POST",
    `/api/sessions/${forkId}/messages`,
    { body: { message: "and now?" } },
  );
  expect(res.status).toBe(201);
  const script = await pending;
  const tools = (script.body.messages as { role: string; content: string }[])
    .filter((message) => message.role === "tool")
    .map((message) => message.content);
  script.reply("later");
  await settle(chat, forkId);
  return tools;
}

const answerOf = (detail: SessionDetail) =>
  detail.messages.find((row) => row.slot === "answer")!.id;

describe("packing tool results", () => {
  test.serial(
    "an archive packs large results and every reader gives the same text",
    async () => {
      const chat = await chatApp();
      const { sessionId, answer } = await toolChat(chat);
      answer.reply("It is noon.");
      await settle(chat, sessionId);
      const bigId = enlarge(chat, sessionId);
      const small = toolRows(chat, sessionId)[1]!;
      expect(Buffer.byteLength(small.content)).toBeLessThan(PACK_FROM);
      expect(BIG.length).toBeLessThan(Buffer.byteLength(BIG));

      const shown = async () =>
        (await (
          await get(chat, `/api/sessions/${sessionId}`)
        ).json()) as SessionDetail;
      const markdown = async () =>
        (await get(chat, `/api/sessions/${sessionId}/markdown?tz=UTC`)).text();
      const before = {
        result: await result(chat, sessionId, bigId),
        small: await result(chat, sessionId, small.id),
        messages: (await shown()).messages,
        markdown: await markdown(),
      };
      expect(before.result).toEqual({
        content: BIG,
        cut: false,
        bytes: Buffer.byteLength(BIG),
      });
      const plainFork = await fork(chat, sessionId, answerOf(await shown()));
      expect(await forkContext(chat, plainFork.session.id)).toContain(BIG);

      expect(
        (await chat.member.call("POST", `/api/sessions/${sessionId}/archive`))
          .status,
      ).toBe(204);
      const [packed, left] = toolRows(chat, sessionId);
      expect(packed).toMatchObject({
        content: "",
        packed_bytes: Buffer.byteLength(BIG),
      });
      expect(packed!.packed!.byteLength).toBeLessThan(Buffer.byteLength(BIG));
      expect(left).toEqual(small);

      // opening the chat reads no blob and says the same sizes
      const decompress = spyOn(Bun, "zstdDecompressSync");
      try {
        expect((await shown()).messages).toEqual(before.messages);
        expect(await markdown()).toBe(before.markdown);
        expect(decompress).not.toHaveBeenCalled();
        expect(await result(chat, sessionId, bigId)).toEqual(before.result);
        expect(decompress).toHaveBeenCalledTimes(1);
        expect(await result(chat, sessionId, small.id)).toEqual(before.small);
        expect(decompress).toHaveBeenCalledTimes(1);
      } finally {
        decompress.mockRestore();
      }

      // a fork is live, so its rows are plain and its model reads them
      const copy = await fork(chat, sessionId, answerOf(await shown()));
      const copied = toolRows(chat, copy.session.id);
      expect(copied.map((row) => [row.content, row.packed])).toEqual([
        [BIG, null],
        [small.content, null],
      ]);
      expect(copy.messages.filter((row) => row.kind === "tool")).toEqual(
        before.messages
          .filter((row) => row.kind === "tool")
          .map((row) => ({
            ...row,
            id: expect.any(String),
            sessionId: copy.session.id,
            sendId: expect.any(String),
          })),
      );
      expect(await forkContext(chat, copy.session.id)).toEqual(
        await forkContext(chat, plainFork.session.id),
      );
      await chat.app.shutdown();
    },
  );

  test("a failed result keeps its text, which its error repeats", async () => {
    const chat = await chatApp();
    const { sessionId, answer } = await toolChat(chat);
    answer.reply("It is noon.");
    await settle(chat, sessionId);
    const [, second] = toolRows(chat, sessionId);
    chat.app.db
      .query(
        `update messages set content = ?, error = ?, status = 'failed'
         where id = ?`,
      )
      .run(BIG, BIG, second!.id);
    enlarge(chat, sessionId);
    expect(
      (await chat.member.call("POST", `/api/sessions/${sessionId}/archive`))
        .status,
    ).toBe(204);
    const [packed, failed] = toolRows(chat, sessionId);
    expect(packed!.packed).not.toBeNull();
    expect(failed).toMatchObject({ content: BIG, packed: null });
    await chat.app.shutdown();
  });

  test.serial(
    "an agent's delete packs a running chat only at the sweep after the stop",
    async () => {
      const { events: logs, logFactory } = collectLogs();
      const chat = await chatApp({ logFactory });
      chat.app.automationScheduler.stop();
      const { sessionId } = await toolChat(chat);
      const bigId = enlarge(chat, sessionId);
      expect(chat.app.sessions.byId(sessionId)!.status).toBe("running");
      expect(
        (await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`)).status,
      ).toBe(200);
      expect(toolRows(chat, sessionId)[0]!.packed).toBeNull();
      await settle(chat, sessionId);
      const session = chat.app.sessions.byId(sessionId)!;
      expect(session.status).toBe("stopped");
      expect(session.archived).toMatchObject({ reason: "agent" });
      expect(toolRows(chat, sessionId)[0]).toMatchObject({
        content: BIG,
        packed: null,
      });

      chat.app.sweep();
      expect(toolRows(chat, sessionId)[0]).toMatchObject({
        content: "",
        packed_bytes: Buffer.byteLength(BIG),
      });
      expect((await result(chat, sessionId, bigId)).content).toBe(BIG);
      expect(
        logs.filter((event) => event.area === "sweep" && event.msg === "sweep"),
      ).toEqual([
        expect.objectContaining({
          fields: expect.objectContaining({ chats_packed: 1 }),
        }),
      ]);
      // nothing left to pack, nothing logged
      chat.app.sweep();
      expect(
        logs.filter((event) => event.area === "sweep" && event.msg === "sweep"),
      ).toHaveLength(1);
      await chat.app.shutdown();
    },
  );

  test.serial(
    "a run is packed after it and its memory phase ended, and reads back the same",
    async () => {
      const { events: logs, logFactory } = collectLogs();
      const chat = await chatApp({ logFactory });
      chat.app.automationScheduler.stop();
      const automation = await createAutomation(chat, { ownMemory: true });
      const run = await startRun(chat, automation.id);
      run.main.toolRound([call("t1")]);
      run.main.end();
      (await waitScript(chat.scripted, 2)).reply("The check passed.");
      const phase = await waitScript(chat.scripted, 3);
      const bigId = enlarge(chat, run.sessionId);
      const before = await result(chat, run.sessionId, bigId);

      // the memory phase runs under the run's running status
      chat.app.sweep();
      expect(toolRows(chat, run.sessionId)[0]!.packed).toBeNull();
      phase.reply("No change.");
      await settle(chat, run.sessionId);
      expect(toolRows(chat, run.sessionId)[0]!.packed).toBeNull();

      chat.app.sweep();
      expect(toolRows(chat, run.sessionId)[0]).toMatchObject({
        content: "",
        packed_bytes: Buffer.byteLength(BIG),
      });
      expect(await result(chat, run.sessionId, bigId)).toEqual(before);
      expect(
        logs.filter((event) => event.area === "sweep" && event.msg === "sweep"),
      ).toEqual([
        expect.objectContaining({
          fields: expect.objectContaining({ runs_packed: 1, chats_packed: 0 }),
        }),
      ]);

      // Fork takes a run whole from its foot
      const detail = (await (
        await get(chat, `/api/sessions/${run.sessionId}`)
      ).json()) as SessionDetail;
      const copy = await fork(chat, run.sessionId, answerOf(detail));
      expect(
        toolRows(chat, copy.session.id).map((row) => [row.content, row.packed]),
      ).toEqual([[BIG, null]]);
      await chat.app.shutdown();
    },
  );
});
