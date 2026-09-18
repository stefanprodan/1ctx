// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { chatApp, startChat, tick } from "../helpers/chat.ts";
import {
  call,
  fakeTools,
  record,
  settle,
  toolRound,
  watch,
  watcher,
} from "../helpers/socket-fixtures.ts";
import { fixture, mcpFetch } from "../server/mcp/fake.ts";

describe("socket fixtures for tools", () => {
  test("one tool round then an answer", async () => {
    const fake = fakeTools({
      c1: { result: { content: "12:00 UTC", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "what time");
    watch(chat, conn, sessionId);
    script.reasoning("let me check");
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    r2.reply("It is noon.");
    await settle(chat, 10);
    record("one-tool-round", detail, conn);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send).toMatchObject({ status: "done", rounds: 2, toolCalls: 1 });
    chat.app.socket.dispose();
  });

  test("an MCP tool round then an answer", async () => {
    const flux = mcpFetch({ recorded: await fixture("flux") });
    const chat = await chatApp({ fetcher: flux.fetcher });
    const { server } = await (
      await chat.admin.call("POST", "/api/mcp", {
        body: {
          name: "flux",
          url: "http://flux.test/mcp",
          keyName: null,
          read: true,
          write: false,
          instructionsOn: true,
          timeoutMs: null,
          readPatterns: ["get_*"],
          writePatterns: [],
          excludedPatterns: [],
        },
      })
    ).json();
    const agent = chat.app.agents.byId(chat.agentId)!;
    const saved = await chat.admin.call("PATCH", `/api/agents/${agent.id}`, {
      body: {
        name: agent.name,
        avatar: agent.avatar,
        providerId: agent.providerId,
        model: agent.model.id,
        thinking: agent.thinking,
        effort: agent.effort,
        prompt: agent.prompt,
        skills: agent.skills,
        servers: [{ serverId: server.id, read: true, write: false }],
        mcpMode: "all",
      },
    });
    expect(saved.status).toBe(200);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "inspect flux");
    watch(chat, conn, sessionId);
    toolRound(script, [
      {
        id: "c1",
        name: "mcp__flux__get_flux_instance",
        arguments: "{}",
      },
    ]);
    const r2 = await chat.scripted.next();
    r2.reply("Flux is ready.");
    await settle(chat, 10);
    record("mcp-call", detail, conn);
    const row = chat.app.sessions
      .messages(sessionId)
      .find((message) => message.kind === "tool")!;
    expect(row).toMatchObject({
      toolName: "mcp__flux__get_flux_instance",
      status: "done",
      content: "called",
    });
    chat.app.socket.dispose();
  });

  test("two tool rounds then an answer", async () => {
    const fake = fakeTools({
      c1: { result: { content: "first", error: false } },
      c2: { result: { content: "second", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "twice");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    toolRound(r2, [call("c2", { timezone: "Asia/Tokyo" })]);
    const r3 = await chat.scripted.next();
    r3.reply("done at last");
    await settle(chat, 14);
    record("two-tool-rounds", detail, conn);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send).toMatchObject({ status: "done", rounds: 3, toolCalls: 2 });
    chat.app.socket.dispose();
  });

  test("narration before a call", async () => {
    const fake = fakeTools({
      c1: { result: { content: "noon", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "when");
    watch(chat, conn, sessionId);
    script.content("I will check the clock.");
    await tick();
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    r2.reply("It is noon.");
    await settle(chat, 10);
    record("narration-before-call", detail, conn);
    const work = chat.app.sessions.messages(sessionId)[1]!;
    expect(work.content).toBe("I will check the clock.");
    chat.app.socket.dispose();
  });

  test("calls with no text", async () => {
    const fake = fakeTools({
      c1: { result: { content: "value", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "no text");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    r2.reply("here it is");
    await settle(chat, 10);
    record("calls-no-text", detail, conn);
    const work = chat.app.sessions.messages(sessionId)[1]!;
    expect(work.content).toBe("");
    chat.app.socket.dispose();
  });

  test("parallel calls finishing out of order", async () => {
    const fake = fakeTools({
      c1: { delayTicks: 6, result: { content: "one", error: false } },
      c2: { delayTicks: 3, result: { content: "two", error: false } },
      c3: { delayTicks: 1, result: { content: "three", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "several");
    watch(chat, conn, sessionId);
    toolRound(script, [
      call("c1", { timezone: "UTC" }),
      call("c2", { timezone: "Asia/Tokyo" }),
      call("c3", { timezone: "Europe/Paris" }),
    ]);
    const r2 = await chat.scripted.next();
    r2.reply("all done");
    await settle(chat, 16);
    record("parallel-out-of-order", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.toolCalls).toBe(3);
    chat.app.socket.dispose();
  });

  test("a tool that fails", async () => {
    const fake = fakeTools({
      c1: { result: { content: "the tool broke", error: true } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "fail tool");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    r2.reply("recovered");
    await settle(chat, 10);
    record("tool-failed", detail, conn);
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    expect(toolRow.status).toBe("failed");
    chat.app.socket.dispose();
  });

  test("a tool timeout", async () => {
    const fake = fakeTools({
      c1: { result: { content: "the request timed out", error: true } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "slow tool");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1", { url: "http://slow.test" })]);
    const r2 = await chat.scripted.next();
    r2.reply("gave up on the fetch");
    await settle(chat, 10);
    record("tool-timeout", detail, conn);
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    expect(toolRow.status).toBe("failed");
    expect(toolRow.content).toContain("timed out");
    chat.app.socket.dispose();
  });

  test("malformed arguments", async () => {
    const fake = fakeTools({
      c1: { result: { content: "arguments were not valid json", error: true } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "bad args");
    watch(chat, conn, sessionId);
    script.toolCall({
      index: 0,
      id: "c1",
      name: "datetime",
      arguments: "{not json",
    });
    script.finish("tool_calls");
    script.usage();
    script.end();
    const r2 = await chat.scripted.next();
    r2.reply("ok");
    await settle(chat, 10);
    record("malformed-arguments", detail, conn);
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    expect(toolRow.status).toBe("failed");
    chat.app.socket.dispose();
  });

  test("an unknown tool", async () => {
    const fake = fakeTools({
      c1: {
        result: { content: "tool not found: does_not_exist", error: true },
      },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "call nothing");
    watch(chat, conn, sessionId);
    script.toolCall({
      index: 0,
      id: "c1",
      name: "does_not_exist",
      arguments: "{}",
    });
    script.finish("tool_calls");
    script.usage();
    script.end();
    const r2 = await chat.scripted.next();
    r2.reply("recovered");
    await settle(chat, 10);
    record("unknown-tool", detail, conn);
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    expect(toolRow.status).toBe("failed");
    chat.app.socket.dispose();
  });

  test("duplicate call ids", async () => {
    const fake = fakeTools({
      dup: { result: { content: "value", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "dupes");
    watch(chat, conn, sessionId);
    script.toolCall({
      index: 0,
      id: "dup",
      name: "datetime",
      arguments: '{"timezone":"UTC"}',
    });
    script.toolCall({
      index: 1,
      id: "dup",
      name: "datetime",
      arguments: '{"timezone":"Asia/Tokyo"}',
    });
    script.finish("tool_calls");
    script.usage();
    script.end();
    const r2 = await chat.scripted.next();
    r2.reply("done");
    await settle(chat, 12);
    record("duplicate-call-ids", detail, conn);
    expect(
      chat.app.sessions
        .messages(sessionId)
        .filter((row) => row.kind === "tool"),
    ).toHaveLength(2);
    chat.app.socket.dispose();
  });

  test("an abort-ignoring tool", async () => {
    // The terminal cleanup must win over the tool's late result.
    const fake = fakeTools({
      c1: { ignoreAbort: 8, result: { content: "late", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "ignore abort");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    await settle(chat, 2);
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settle(chat, 12);
    record("abort-ignoring-tool", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("stop");
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    expect(toolRow.status).toBe("stopped");
    chat.app.socket.dispose();
  });

  test("a finishTool failure", async () => {
    const fake = fakeTools({
      c1: { result: { content: "value", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(
      chat,
      "tool write fail",
    );
    watch(chat, conn, sessionId);
    const original = chat.app.sessions.finishTool.bind(chat.app.sessions);
    let throwOnce = false;
    (chat.app.sessions as { finishTool: unknown }).finishTool = (
      ...args: unknown[]
    ) => {
      // Restore the writer so finalizeSend can commit the terminal envelope.
      if (throwOnce) {
        throwOnce = false;
        (chat.app.sessions as { finishTool: unknown }).finishTool = original;
        throw new Error("tool row write failed");
      }
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    toolRound(script, [call("c1")]);
    throwOnce = true;
    await settle(chat, 10);
    (chat.app.sessions as { finishTool: unknown }).finishTool = original;
    record("finishtool-failure", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("failure");
    chat.app.socket.dispose();
  });

  test("a skill tool round then an answer", async () => {
    const chat = await chatApp();
    chat.app.skills.create(
      {
        name: "gitops-knowledge",
        description: "Flux CD expert",
        body: "Use the gitops skill.",
        license: "",
        compatibility: "",
        metadata: {},
        allowedTools: "",
        sourceKind: "file",
        sourceUrl: "https://skills.test/gitops.md",
        sourceSelect: "",
        sourceDigest: "",
        digest: "gitops-digest",
        dropped: [],
        droppedMore: 0,
        files: [],
      },
      chat.app.now.value,
    );
    const skill = chat.app.skills.list()[0]!;
    chat.app.skills.assign(chat.agentId, [skill.id]);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "flux help");
    watch(chat, conn, sessionId);
    toolRound(script, [
      {
        id: "c1",
        name: "skill",
        arguments: JSON.stringify({ name: "gitops-knowledge" }),
      },
    ]);
    const r2 = await chat.scripted.next();
    r2.reply("Here is what the skill says.");
    await settle(chat, 10);
    record("skill-tool-round", detail, conn);
    const row = chat.app.sessions
      .messages(sessionId)
      .find((message) => message.kind === "tool")!;
    expect(row.toolName).toBe("skill");
    expect(row.status).toBe("done");
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send).toMatchObject({ status: "done", rounds: 2, toolCalls: 1 });
    chat.app.socket.dispose();
  });
});
