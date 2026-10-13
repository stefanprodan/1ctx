// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tasks tool over /mcp on the composed server: the label filter and
// line from the real store, and an agent's unclaim with its retry.

import { describe, expect, test } from "bun:test";
import { createKey } from "../../helpers/access-keys.ts";
import { type ChatApp, chatApp } from "../../helpers/chat.ts";
import { briefFile } from "../external-tasks/http-fixture.ts";

async function tasks(chat: ChatApp, token: string, args: object) {
  const response = await chat.app.client().call("POST", "/mcp", {
    raw: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "tasks",
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
        },
      },
    }),
    headers: {
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "tasks",
    },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  return {
    error: body.result.isError === true,
    text: (body.result.content as { text: string }[])
      .map((part) => part.text)
      .join("\n"),
  };
}

const ids = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line).id as string)
    .sort();

describe("the tasks tool on the composed server", () => {
  test("filters by labels, names the project's labels and gives a task back once", async () => {
    const chat = await chatApp();
    try {
      chat.app.automationScheduler.stop();
      const area = chat.app.externalTasks;
      const fileId = briefFile(chat.app, chat.projectId, chat.memberId);
      const make = (title: string, labels: string[]) =>
        area.create(chat.memberId, chat.projectId, {
          title,
          labels,
          fileIds: [fileId],
        }).task.task.id;
      const build = make("Build it", ["build"]);
      const fix = make("Fix it", ["fix", "plan"]);
      make("Research it", ["research"]);
      const write = await createKey(chat.member, {
        name: "laptop",
        scope: "write",
      });
      const read = await createKey(chat.member, {
        name: "reader",
        scope: "read",
      });

      const name = chat.app.projects.byId(chat.projectId)!.name;
      for (const token of [read.token, write.token]) {
        const listed = await tasks(chat, token, {
          action: "list",
          projectId: chat.projectId,
          labels: ["Build", "fix"],
        });
        expect(ids(listed.text)).toEqual([build, fix].sort());
        expect(listed.text).toEndWith(
          `\nLabels in ${name}: build (1 open), fix (1 open), plan (1 open), research (1 open).\nEnd of tasks.`,
        );
      }

      const key = { userId: chat.memberId, keyId: write.key.id };
      const claimed = await tasks(chat, write.token, {
        action: "claim",
        taskId: build,
      });
      const claimId = /^Claim (\w+) for task/.exec(claimed.text)![1]!;
      expect(claimed.text).toContain(`"fileId":"${fileId}"`);
      expect(claimed.text).toContain('"labels":["build"]');
      area.report(
        { ...key, keyName: "laptop" },
        build,
        claimId,
        "progress",
        "**Half** done, see https://example.test/pull/1",
        [],
      );
      const shown = await tasks(chat, read.token, {
        action: "show",
        taskId: build,
      });
      expect(shown.text).toContain("**Half** done");
      expect(shown.text).not.toMatch(/<strong>|<a |"html"/);

      const refused = await tasks(chat, read.token, {
        action: "unclaim",
        taskId: build,
        claimId,
        text: "Not mine.",
      });
      expect(refused).toEqual({
        error: true,
        text: "this access key is read-only",
      });
      const kind = await tasks(chat, write.token, {
        action: "report",
        taskId: build,
        claimId,
        kind: "unclaim",
        text: "Later.",
      });
      expect(kind.error).toBe(true);
      expect(kind.text).toContain("kind must be one of");
      expect(area.store.byId(build)!.state).toBe("in_progress");

      const back = await tasks(chat, write.token, {
        action: "unclaim",
        taskId: build,
        claimId,
        text: "Out of time.",
      });
      expect(back.error).toBe(false);
      expect(area.store.byId(build)!.state).toBe("todo");
      const entries = area.store.byId(build)!.entries;
      const again = await tasks(chat, write.token, {
        action: "unclaim",
        taskId: build,
        claimId,
        text: "Out of time.",
      });
      expect(again).toEqual(back);
      expect(area.store.byId(build)!.entries).toBe(entries);
    } finally {
      await chat.app.shutdown();
    }
  });
});
