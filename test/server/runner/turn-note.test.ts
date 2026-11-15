// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The author's day on a turn's first message: said before the turn only
// where it changes, so midnight leaves the system prompt and every
// earlier turn as they were.

import { describe, expect, test } from "bun:test";
import { DAY_MS } from "../../../src/server/lib/clock.ts";
import { channelLocal } from "../../../src/server/runner/channel-prompt.ts";
import {
  historyMessages,
  SUMMARY_LEAD,
} from "../../../src/server/runner/context.ts";
import { NO_REPO_LINES, turnNote } from "../../../src/server/runner/prompt.ts";
import type {
  ContextLookups,
  RenderPolicy,
  Turn,
} from "../../../src/server/runner/render.ts";
import type { Message } from "../../../src/shared/contracts/session.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import { channelApp, localAt } from "../../helpers/channel.ts";
import type { ChatApp, Script } from "../../helpers/chat.ts";
import {
  chatApp,
  DAY,
  DAY_NOTE,
  sessionSettled,
  startChat,
} from "../../helpers/chat.ts";

const FRIDAY = "Today is Friday, 1970-01-02 (UTC).";
const WEDNESDAY = "Today is Wednesday, 1969-12-31 (America/Los_Angeles).";

const row = (
  fields: Partial<Message> & Pick<Message, "id" | "kind" | "sendId">,
): Message => ({
  sessionId: "s",
  uploads: null,
  files: null,
  saved: null,
  seq: 1,
  round: 1,
  slot: null,
  userId: fields.kind === "user" ? "u1" : null,
  agentId: null,
  content: "",
  reasoning: "",
  html: "",
  status: "done",
  error: null,
  finishReason: null,
  toolCalls: null,
  toolCallId: null,
  toolName: null,
  model: null,
  ttftMs: null,
  thinkingMs: null,
  upstream: null,
  servedModel: null,
  nativeFinish: null,
  createdAt: 0,
  finishedAt: null,
  resultBytes: null,
  promptTokens: null,
  ...fields,
});

const policy: RenderPolicy = {
  username: "casey",
  userId: "u1",
  providerId: "pr",
  model: "org/model",
  agentId: "a",
  summoned: null,
  offered: { mcp: [], skills: { block: "", skills: [] } },
};

// a turn per send: its user row, then its answer
const turnRows = (sendId: string, text: string): Message[] => [
  row({ id: `${sendId}-u`, kind: "user", sendId, content: text }),
  row({ id: `${sendId}-r`, kind: "reply", sendId, content: `${text} done` }),
];

const turnOf = (
  sendId: string,
  note: string | null,
  repos: string | null = null,
) =>
  [
    sendId,
    {
      agentId: "a",
      agentName: "coder",
      summoned: false,
      firstMessageId: `${sendId}-u`,
      repos,
      note,
    },
  ] as [string, Turn];

const lookupsOf = (turns: [string, Turn][]): ContextLookups => ({
  usernameOf: () => null,
  reasoningDetailsOf: () => null,
  turnsOf: () => new Map(turns),
});

const contents = (messages: { content: unknown }[]) =>
  messages.map((message) => message.content);

describe("turnNote", () => {
  test("names the weekday and the date in the author's zone", () => {
    const at = Date.UTC(2026, 10, 15, 10, 0);
    expect(turnNote(at, "Europe/Bucharest")).toBe(
      "Today is Sunday, 2026-11-15 (Europe/Bucharest).",
    );
    // 20:00 in Los Angeles is already Monday in UTC
    const evening = Date.UTC(2026, 10, 16, 4, 0);
    expect(turnNote(evening, "America/Los_Angeles")).toBe(
      "Today is Sunday, 2026-11-15 (America/Los_Angeles).",
    );
    expect(turnNote(evening, "UTC")).toBe("Today is Monday, 2026-11-16 (UTC).");
  });

  test("an unknown zone says the UTC day and names UTC", () => {
    expect(turnNote(Date.UTC(2026, 10, 16, 4, 0), "Mars/Olympus")).toBe(
      "Today is Monday, 2026-11-16 (UTC).",
    );
  });
});

describe("a turn's note in history", () => {
  test("same-day turns say it once, before the first", () => {
    const rows = [...turnRows("t1", "one"), ...turnRows("t2", "two")];
    const lookups = lookupsOf([turnOf("t1", DAY_NOTE), turnOf("t2", DAY_NOTE)]);
    expect(contents(historyMessages(rows, policy, lookups))).toEqual([
      DAY_NOTE,
      "one",
      "one done",
      "two",
      "two done",
    ]);
  });

  test("a later day says its own, the earlier turns' messages unchanged", () => {
    const before = [...turnRows("t1", "one"), ...turnRows("t2", "two")];
    const later = [...before, ...turnRows("t3", "three")];
    const turns = [
      turnOf("t1", DAY_NOTE),
      turnOf("t2", DAY_NOTE),
      turnOf("t3", FRIDAY),
    ];
    const first = historyMessages(before, policy, lookupsOf(turns));
    const second = historyMessages(later, policy, lookupsOf(turns));
    expect(second.slice(0, first.length)).toEqual(first);
    expect(contents(second.slice(first.length))).toEqual([
      FRIDAY,
      "three",
      "three done",
    ]);
  });

  test("goes with the repository block in one message, a turn with none says none", () => {
    const rows = [
      ...turnRows("t0", "old"),
      ...turnRows("t1", "one"),
      ...turnRows("t2", "two"),
    ];
    const repos = "Repositories mounted for this turn:\n/repos/w (abc1234)";
    const lookups = lookupsOf([
      turnOf("t0", null),
      turnOf("t1", DAY_NOTE, repos),
      turnOf("t2", DAY_NOTE, repos),
    ]);
    expect(contents(historyMessages(rows, policy, lookups))).toEqual([
      "old",
      "old done",
      `${DAY_NOTE}\n\n${repos}`,
      "one",
      "one done",
      repos,
      "two",
      "two done",
    ]);
  });

  test("the first turn after a summary says it again", () => {
    const rows = [
      ...turnRows("t1", "one"),
      row({
        id: "sum",
        kind: "summary",
        sendId: "c1",
        content: "## Goal",
      }),
      ...turnRows("t2", "two"),
    ];
    const lookups = lookupsOf([turnOf("t1", DAY_NOTE), turnOf("t2", DAY_NOTE)]);
    expect(contents(historyMessages(rows, policy, lookups))).toEqual([
      `${SUMMARY_LEAD}\n\n## Goal`,
      DAY_NOTE,
      "two",
      "two done",
    ]);
  });
});

describe("a kept tail after a summary", () => {
  test("says each note where it changes, its first turn its own", () => {
    const rows = [
      // too long for the tail, so the tail starts after it
      ...turnRows("t0", "x".repeat(200_000)),
      ...turnRows("t1", "one"),
      ...turnRows("t2", "two"),
      ...turnRows("t3", "three"),
      row({ id: "sum", kind: "summary", sendId: "c1", content: "## Goal" }),
      ...turnRows("t4", "four"),
      ...turnRows("t5", "five"),
    ];
    const lookups = lookupsOf([
      turnOf("t0", DAY_NOTE),
      turnOf("t1", DAY_NOTE),
      turnOf("t2", FRIDAY),
      turnOf("t3", FRIDAY),
      turnOf("t4", FRIDAY),
      turnOf("t5", DAY_NOTE),
    ]);
    const room = {
      window: 100_000,
      reserve: 0,
      wire: null,
      system: [],
      tools: [],
      imagesPerRequest: 10,
    };
    expect(contents(historyMessages(rows, policy, lookups, room))).toEqual([
      `${SUMMARY_LEAD}\n\n## Goal`,
      DAY_NOTE,
      "one",
      "one done",
      FRIDAY,
      "two",
      "two done",
      "three",
      "three done",
      "four",
      "four done",
      DAY_NOTE,
      "five",
      "five done",
    ]);
  });
});

describe("a channel's request-local message", () => {
  test("says the author's local day", () => {
    const local = channelLocal(
      {
        fullName: "Casey Doe",
        username: "casey",
        about: "",
        tz: "America/Los_Angeles",
        projectMemory: [],
      },
      Date.UTC(2026, 10, 16, 4, 0),
      "",
      NO_REPO_LINES,
    );
    expect(local).toContain(
      "\n\nToday is Sunday, 2026-11-15 (America/Los_Angeles).",
    );
    expect(local).not.toContain("2026-11-16");
  });
});

async function finish(chat: ChatApp, sessionId: string, script: Script) {
  script.reply("done");
  await sessionSettled(chat.app, sessionId);
}

async function message(chat: ChatApp, sessionId: string, text: string) {
  const pending = chat.scripted.next();
  const response = await chat.member.call(
    "POST",
    `/api/sessions/${sessionId}/messages`,
    { body: { message: text } },
  );
  expect(response.status).toBe(201);
  return pending;
}

const sent = (script: Script) =>
  script.body.messages as { role: string; content: string; name?: string }[];

const noteOf = (chat: ChatApp, messageId: string) =>
  chat.app.db
    .query<{ turn_note: string | null }, [string]>(
      "select turn_note from messages where id = ?",
    )
    .get(messageId)?.turn_note;

const firstUser = (chat: ChatApp, sessionId: string) =>
  chat.app.sessions.messages(sessionId).find((row) => row.kind === "user")!;

describe("a chat's turn note", () => {
  test("is said once a day, and a later day leaves the earlier bytes", async () => {
    const chat = await chatApp();
    try {
      const { script, sessionId } = await startChat(chat, "one");
      expect(sent(script)[0]!.content).not.toContain("Today is");
      expect(sent(script).slice(1)).toEqual([
        DAY,
        { role: "user", content: "one", name: "casey" },
      ]);
      await finish(chat, sessionId, script);
      const two = await message(chat, sessionId, "two");
      expect(sent(two).filter((m) => m.content === DAY_NOTE)).toHaveLength(1);
      await finish(chat, sessionId, two);
      chat.app.now.value += DAY_MS;
      const three = await message(chat, sessionId, "three");
      expect(sent(three).slice(0, sent(two).length)).toEqual(sent(two));
      expect(sent(three).slice(-2)).toEqual([
        { role: "user", content: FRIDAY },
        { role: "user", content: "three", name: "casey" },
      ]);
      await finish(chat, sessionId, three);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("is in the author's zone", async () => {
    const chat = await chatApp();
    try {
      chat.app.db
        .query("update users set tz = 'Europe/Bucharest' where id = ?")
        .run(chat.memberId);
      const { script, sessionId } = await startChat(chat, "one");
      expect(sent(script)[1]).toEqual({
        role: "user",
        content: "Today is Thursday, 1970-01-01 (Europe/Bucharest).",
      });
      await finish(chat, sessionId, script);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a regenerate replaces it with its own day", async () => {
    const chat = await chatApp();
    try {
      const { script, sessionId } = await startChat(chat, "one");
      await finish(chat, sessionId, script);
      expect(noteOf(chat, firstUser(chat, sessionId).id)).toBe(DAY_NOTE);
      chat.app.now.value += DAY_MS;
      const pending = chat.scripted.next();
      const response = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/regenerate`,
      );
      expect(response.status).toBe(201);
      const again = await pending;
      expect(sent(again).slice(1)).toEqual([
        { role: "user", content: FRIDAY },
        { role: "user", content: "one", name: "casey" },
      ]);
      expect(noteOf(chat, firstUser(chat, sessionId).id)).toBe(FRIDAY);
      await finish(chat, sessionId, again);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a queued turn of several messages has one, before its first", async () => {
    const chat = await chatApp();
    try {
      const { script, sessionId } = await startChat(chat, "first");
      // the author's zone moves while the turn runs, so the queued turn
      // reads another day: a clock moved under a live stream ends it
      chat.app.db
        .query("update users set tz = 'America/Los_Angeles' where id = ?")
        .run(chat.memberId);
      for (const text of ["one", "two"]) {
        const response = await chat.member.call(
          "POST",
          `/api/sessions/${sessionId}/messages`,
          { body: { message: text } },
        );
        expect(response.status).toBe(202);
      }
      const pending = chat.scripted.next();
      script.reply("done");
      const next = await pending;
      expect(contents(sent(next).slice(1))).toEqual([
        DAY_NOTE,
        "first",
        "done",
        WEDNESDAY,
        "one",
        "two",
      ]);
      const notes = chat.app.sessions
        .messages(sessionId)
        .filter((row) => row.kind === "user")
        .map((row) => noteOf(chat, row.id));
      expect(notes).toEqual([DAY_NOTE, WEDNESDAY, null]);
      await finish(chat, sessionId, next);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a run stores none", async () => {
    const chat = await chatApp();
    try {
      const automation = await createAutomation(chat);
      const run = await startRun(chat, automation.id);
      expect(JSON.stringify(sent(run.main))).not.toContain("Today is");
      expect(noteOf(chat, firstUser(chat, run.sessionId).id)).toBeNull();
      run.main.reply("done");
      await settleRun(chat, run.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a channel stores none, for a post or a summoned turn", async () => {
    const { chat, channelId, post } = await channelApp();
    try {
      expect((await post("just a note")).status).toBe(201);
      await sessionSettled(chat.app, channelId);
      const pending = chat.scripted.next();
      expect((await post("@coder look")).status).toBe(201);
      const script = await pending;
      expect(sent(script)[localAt(script)]!.content).toContain(
        `\n\n${DAY_NOTE}`,
      );
      script.reply("done");
      await sessionSettled(chat.app, channelId);
      const notes = chat.app.sessions
        .messages(channelId)
        .filter((row) => row.kind === "user")
        .map((row) => noteOf(chat, row.id));
      expect(notes).toEqual([null, null]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a fork copies it", async () => {
    const chat = await chatApp();
    try {
      const { script, sessionId } = await startChat(chat, "one");
      await finish(chat, sessionId, script);
      const answer = chat.app.sessions
        .messages(sessionId)
        .findLast((row) => row.kind === "reply")!;
      chat.app.now.value += DAY_MS;
      const response = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/fork`,
        { body: { messageId: answer.id, agentId: chat.agentId } },
      );
      expect(response.status).toBe(201);
      const fork = (await response.json()).session.id as string;
      expect(noteOf(chat, firstUser(chat, fork).id)).toBe(DAY_NOTE);
      const next = await message(chat, fork, "two");
      expect(contents(sent(next).slice(1))).toEqual([
        DAY_NOTE,
        "one",
        "done",
        FRIDAY,
        "two",
      ]);
      await finish(chat, fork, next);
    } finally {
      await chat.app.shutdown();
    }
  });
});
