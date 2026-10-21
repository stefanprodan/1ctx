// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An outside agent's own tasks over /mcp on the composed server: create
// with the page's checks, a retry, the key on the page, its list and
// its edit and cancel of its own todo tasks.

import { describe, expect, test } from "bun:test";
import { createKey } from "../../helpers/access-keys.ts";
import type { TestClient } from "../../helpers/app.ts";
import { httpFixture } from "../external-tasks/http-fixture.ts";

type Fixture = Awaited<ReturnType<typeof httpFixture>>;

async function tasks(f: Fixture, token: string, args: object) {
  const response = await f.app.client().call("POST", "/mcp", {
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

const idOf = (text: string) => /, id (\w+), state /.exec(text)![1]!;

const detailOf = (text: string) =>
  JSON.parse(
    text
      .split("\n")
      .find((line) => line.startsWith("Task detail: "))!
      .slice("Task detail: ".length),
  );

const entriesOf = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("Entry: "))
    .map((line) => JSON.parse(line.slice("Entry: ".length)));

const rowsOf = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));

async function writeKey(client: TestClient, name: string) {
  return (await createKey(client, { name })).token;
}

describe("an outside agent's own tasks over /mcp", () => {
  test("creates with the page's checks and answers a retry with the first", async () => {
    await using f = await httpFixture();
    const token = await writeKey(f.creator.client, "laptop");
    const brief = {
      action: "create",
      projectId: f.projectId,
      title: "Split the parser",
      labels: ["build"],
      fileIds: [f.briefId],
    };
    const made = await tasks(f, token, brief);
    expect(made.error).toBe(false);
    expect(made.text).toStartWith('Created task "Split the parser", id ');
    const id = idOf(made.text);
    expect(detailOf(made.text).task).toMatchObject({
      state: "todo",
      createdBy: { username: "creator" },
      createdByYou: true,
    });
    const page = await f.show(id);
    expect(page.task.createdKeyName).toBe("laptop");
    expect(page.task.task.createdBy?.username).toBe("creator");
    expect(page.entries).toEqual([]);
    expect(
      f.app.db
        .query<{ created_key_name: string }, [string]>(
          "select created_key_name from external_tasks where id = ?",
        )
        .get(id),
    ).toEqual({ created_key_name: "laptop" });
    // it waits on an agent, never on Home
    const home = await f.creator.client.call(
      "GET",
      "/api/external-tasks?waiting=1",
    );
    expect((await home.json()).count).toBe(0);

    // a retry answers the first; another key makes its own
    const again = await tasks(f, token, brief);
    expect(idOf(again.text)).toBe(id);
    const other = await tasks(f, await writeKey(f.creator.client, "desk"), {
      ...brief,
    });
    expect(idOf(other.text)).not.toBe(id);

    // the route's words for a bad brief
    for (const fields of [
      { title: "" },
      { labels: ["nope"] },
      { labels: [] },
      { fileIds: ["missingfile1"] },
    ]) {
      const route = await f.creator.client.call(
        "POST",
        `/api/projects/${f.projectId}/external-tasks`,
        {
          body: {
            title: "Bad brief",
            labels: ["build"],
            fileIds: [f.briefId],
            ...fields,
          },
        },
      );
      expect(route.status).toBe(400);
      const refused = await tasks(f, token, {
        ...brief,
        title: "Bad brief",
        ...fields,
      });
      expect(refused).toEqual({
        error: true,
        text: (await route.json()).error,
      });
    }

    // a project the key's user cannot see is not found
    const outside = await tasks(
      f,
      await writeKey(f.outsider.client, "away"),
      brief,
    );
    expect(outside).toEqual({ error: true, text: "no such project" });
  });

  test("lists, edits and cancels only the key's own todo tasks", async () => {
    await using f = await httpFixture();
    const token = await writeKey(f.creator.client, "laptop");
    const other = await writeKey(f.creator.client, "desk");
    const create = async (title: string, key = token) =>
      idOf(
        (
          await tasks(f, key, {
            action: "create",
            projectId: f.projectId,
            title,
            labels: ["build"],
            fileIds: [f.briefId],
          })
        ).text,
      );
    const mine = await create("Mine");
    const theirs = await create("Theirs", other);
    const member = (await f.create({ title: "A member's" })).task.task.id;

    const listed = await tasks(f, token, {
      action: "list",
      projectId: f.projectId,
      created: true,
    });
    expect(rowsOf(listed.text).map((row) => row.id)).toEqual([mine]);
    expect(rowsOf(listed.text)[0].createdByYou).toBe(true);
    const all = rowsOf(
      (await tasks(f, token, { action: "list", projectId: f.projectId })).text,
    );
    expect(all).toHaveLength(3);
    expect(all.filter((row) => row.createdByYou).map((row) => row.id)).toEqual([
      mine,
    ]);
    expect(
      await tasks(f, token, { action: "list", held: true, created: true }),
    ).toEqual({ error: true, text: "choose held or created, not both" });

    const edited = await tasks(f, token, {
      action: "edit",
      taskId: mine,
      editRevision: 0,
      title: "Mine, sharper",
    });
    expect(edited.text).toStartWith('Edited task "Mine, sharper"');
    expect(entriesOf(edited.text)[0]).toMatchObject({
      kind: "edit",
      by: "you",
      keyName: "laptop",
      claimId: null,
    });
    const shown = await tasks(f, token, { action: "show", taskId: mine });
    expect(entriesOf(shown.text)[0]).toMatchObject({ kind: "edit", by: "you" });
    // another key reads it as an agent's entry, not its own
    const seen = await tasks(f, other, { action: "show", taskId: mine });
    expect(entriesOf(seen.text)[0].by).toBeUndefined();

    const refusal = {
      error: true,
      text: "only this key's tasks in todo can be changed over MCP",
    };
    for (const taskId of [theirs, member]) {
      expect(
        await tasks(f, token, {
          action: "edit",
          taskId,
          editRevision: 0,
          title: "Taken over",
        }),
      ).toEqual(refusal);
      expect(await tasks(f, token, { action: "cancel", taskId })).toEqual(
        refusal,
      );
    }
    // a claim landing first refuses the move
    const claimed = await tasks(f, other, { action: "claim", taskId: mine });
    expect(claimed.error).toBe(false);
    expect(await tasks(f, token, { action: "cancel", taskId: mine })).toEqual(
      refusal,
    );

    const spare = await create("Spare");
    const canceled = await tasks(f, token, { action: "cancel", taskId: spare });
    expect(canceled.text).toStartWith('Canceled task "Spare"');
    expect(entriesOf(canceled.text)[0]).toMatchObject({
      kind: "cancel",
      by: "you",
      keyName: "laptop",
    });
    const page = await f.show(spare);
    expect(page.task.task).toMatchObject({
      state: "canceled",
      last: { kind: "cancel", keyName: "laptop" },
    });
    expect(page.entries[0]).toMatchObject({
      kind: "cancel",
      by: { username: "creator" },
      keyName: "laptop",
    });
  });
});
