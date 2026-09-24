// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { format } from "../../src/server/lib/log.ts";
import type { Tools } from "../../src/server/tools/index.ts";
import { collectLogs } from "../helpers/app.ts";
import { chatApp, startChat, tick, waitScript } from "../helpers/chat.ts";
import { link, seedServer } from "../server/mcp/switches.helpers.ts";

const at = new Date("2026-09-22T10:00:00.000Z");

function rendered(logs: ReturnType<typeof collectLogs>): string {
  return logs.events
    .flatMap((event) => [
      JSON.stringify(event),
      format(at, event.area, event.level, event.msg, event.fields),
    ])
    .join("\n");
}

test("events omit private request and chat values", async () => {
  const privateValues = {
    message: "canary-user-message-701",
    prompt: "canary-agent-prompt-702",
    description: "canary-project-description-703",
    arguments: "canary-tool-arguments-704",
    result: "canary-tool-result-705",
    query: "canary-query-string-706",
    path: "canary-raw-path-707",
    login: "canary-login-708@example.test",
    file: "canary-file-name-709.md",
    text: "canary-file-text-710",
    urlUser: "canary-url-user-711",
    urlPassword: "canary-url-password-712",
    urlQuery: "canary-url-query-713",
  };
  const fetched: string[] = [];
  const privateFetch = (async (input: string | URL | Request) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return new Response(privateValues.result);
  }) as typeof fetch;
  const tools: Tools = {
    capabilities: () => ["web"],
    serverNames: () => [],
    skillsOff: () => [],
    offered: () => ({
      tools: [
        { name: "webfetch", description: "Fetch a URL.", parameters: {} },
      ],
      visuals: false,
      search: null,
      skills: { block: "", skills: [] },
      mcp: [],
      mcpPrompt: { text: "", digest: {} },
      mcpCatalog: "",
      memory: null,
      credentials: [],
      credentialsOff: [],
      web: null,
    }),
    async run(_offered, call) {
      const args = JSON.parse(call.arguments) as { url: string };
      const response = await privateFetch(args.url);
      return { content: await response.text(), error: false };
    },
  };
  const logs = collectLogs();
  const chat = await chatApp({ logFactory: logs.logFactory, tools });
  chat.app.db
    .query("update agents set prompt = ? where id = ?")
    .run(privateValues.prompt, chat.agentId);
  chat.app.db
    .query("update projects set description = ? where id = ?")
    .run(privateValues.description, chat.projectId);

  expect(
    (
      await chat.member.call(
        "GET",
        `/api/${privateValues.path}?search=${privateValues.query}`,
      )
    ).status,
  ).toBe(404);
  expect(
    (await chat.app.client().login(privateValues.login, "not-the-password"))
      .status,
  ).toBe(401);
  expect(
    (
      await chat.member.call(
        "POST",
        `/api/projects/${chat.projectId}/knowledge`,
        { body: { name: privateValues.file, text: privateValues.text } },
      )
    ).status,
  ).toBe(201);

  const started = await startChat(chat, privateValues.message);
  const url = `https://${privateValues.urlUser}:${privateValues.urlPassword}@fetch.test/data?token=${privateValues.urlQuery}`;
  started.script.toolRound([
    {
      id: "fetch",
      name: "webfetch",
      arguments: JSON.stringify({ url, note: privateValues.arguments }),
    },
  ]);
  started.script.end();
  const answer = await waitScript(chat.scripted, 2);
  answer.reply("done");
  await tick();
  await tick();

  expect(fetched[0]).toBe(url);
  const output = rendered(logs);
  for (const value of Object.values(privateValues)) {
    expect(output).not.toContain(value);
  }
  await chat.app.shutdown();
  chat.app.db.close();
});

test("failure events scrub keys, URLs, later lines and causes", async () => {
  const providerKey = "provider-private-value-721";
  const mcpKey = "mcp-private-value-722";
  const urlUser = "canary-error-user-723";
  const urlPassword = "canary-error-password-724";
  const urlQuery = "canary-error-query-725";
  const laterLine = "canary-error-line-726";
  const causeMarker = "canary-error-cause-727";
  const remoteError = new Error(
    `failed ${providerKey} ${mcpKey} https://${urlUser}:${urlPassword}@fault.test/mcp?token=${urlQuery}\n${laterLine}`,
    { cause: new Error(causeMarker) },
  );
  const failingMcp = (async () => {
    throw remoteError;
  }) as unknown as typeof fetch;
  const logs = collectLogs();
  const chat = await chatApp({
    fetcher: failingMcp,
    logFactory: logs.logFactory,
    secrets: {
      "provider-local": providerKey,
      "mcp-fault": mcpKey,
    },
  });
  chat.app.db
    .query("update providers set key_name = ? where id = ?")
    .run("provider-local", chat.providerId);
  const server = seedServer(chat.app.mcp, "fault");
  chat.app.db
    .query("update mcp_servers set key_name = ? where id = ?")
    .run("mcp-fault", server.id);
  chat.app.mcp.setAgentServers(chat.agentId, [link(server)]);

  const mcp = await startChat(chat, "call the server");
  mcp.script.toolRound([
    {
      id: "mcp",
      name: "mcp__fault__get_item0",
      arguments: '{"query":"safe"}',
    },
  ]);
  mcp.script.end();
  const answer = await waitScript(chat.scripted, 2);
  answer.reply("done");
  await tick();
  await tick();

  chat.scripted.refuse(500, remoteError.message);
  const failed = await chat.member.call("POST", "/api/sessions", {
    body: {
      projectId: chat.projectId,
      agentId: chat.agentId,
      message: "safe failure",
    },
  });
  expect(failed.status).toBe(201);
  await tick();
  await tick();

  const failures = logs.events.filter(
    (event) => event.msg === "tool failed" || event.msg === "send end",
  );
  expect(failures.some((event) => event.msg === "tool failed")).toBeTrue();
  expect(
    failures.some(
      (event) => event.msg === "send end" && event.fields.cause === "failure",
    ),
  ).toBeTrue();
  for (const event of failures) {
    if (typeof event.fields.error === "string") {
      expect(event.fields.error.length).toBeLessThanOrEqual(200);
      expect(event.fields.error).not.toContain("\n");
    }
  }
  const output = rendered(logs);
  for (const value of [
    providerKey,
    mcpKey,
    urlUser,
    urlPassword,
    urlQuery,
    laterLine,
    causeMarker,
  ]) {
    expect(output).not.toContain(value);
  }
  await chat.app.shutdown();
  chat.app.db.close();
});
