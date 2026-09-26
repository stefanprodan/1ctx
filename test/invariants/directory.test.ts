// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's page and an agent's page are open to every signed-in user.
// A user's page lists only the team projects both users are members
// of; an agent's page lists the tools a send would offer it now.

import { describe, expect, test } from "bun:test";
import { tokens } from "../../src/server/lib/tokens.ts";
import { wireTokens } from "../../src/server/providers/index.ts";
import type { LoadedSkill } from "../../src/server/skills/load.ts";
import type {
  DirectoryAgentResponse,
  DirectoryUserResponse,
} from "../../src/shared/api/directory.ts";
import type { ToolsResponse } from "../../src/shared/api/tools.ts";
import { hashPassword } from "../helpers/app.ts";
import {
  type ChatApp,
  chatApp,
  FLASH,
  NO_TOOLS,
  startChat,
} from "../helpers/chat.ts";

const loaded = (
  name: string,
  body: string,
  files: LoadedSkill["files"] = [],
): LoadedSkill => ({
  name,
  description: `Use ${name}.`,
  body,
  license: "",
  compatibility: "",
  metadata: {},
  allowedTools: "",
  sourceKind: "file",
  sourceUrl: `https://skills.test/${name}/SKILL.md`,
  sourceSelect: "",
  sourceDigest: "",
  digest: `sha256:${name}:${body.length}`,
  dropped: [],
  droppedMore: 0,
  files,
});

async function team(chat: ChatApp, name: string, members: string[]) {
  const res = await chat.admin.call("POST", "/api/projects", {
    body: { name },
  });
  expect(res.status).toBe(201);
  const { project } = await res.json();
  for (const userId of members) {
    const added = await chat.admin.call(
      "POST",
      `/api/projects/${project.id}/members`,
      { body: { userId } },
    );
    expect(added.status).toBe(201);
  }
  return project.id as string;
}

describe("the directory", () => {
  test("a member opens another user's page with the email, zone and about", async () => {
    const chat = await chatApp();
    const other = chat.app.createUser({
      username: "bogdan",
      fullName: "Bogdan P",
      email: "bogdan@example.com",
      role: "member",
      tz: "Europe/Bucharest",
      passwordHash: await hashPassword("pw"),
      mustChangePassword: false,
      now: chat.app.now.value,
    });
    chat.app.users.setDetails(other.id, {
      fullName: "Bogdan P",
      about: "Head of SRE.",
    });
    const res = await chat.member.call("GET", "/api/directory/users/bogdan");
    expect(res.status).toBe(200);
    const body: DirectoryUserResponse = await res.json();
    expect(body.user).toEqual({
      id: other.id,
      username: "bogdan",
      fullName: "Bogdan P",
      role: "member",
      email: "bogdan@example.com",
      tz: "Europe/Bucharest",
      about: "Head of SRE.",
      createdAt: chat.app.now.value,
      disabled: false,
    });
    expect(JSON.stringify(body)).not.toContain("passwordHash");
    expect(
      (await chat.member.call("GET", "/api/directory/users/nobody")).status,
    ).toBe(404);
  });

  test("projects in common are team projects both may open", async () => {
    const chat = await chatApp();
    const other = chat.app.createUser({
      username: "bogdan",
      fullName: "Bogdan P",
      email: "bogdan@example.com",
      role: "member",
      passwordHash: await hashPassword("pw"),
      mustChangePassword: false,
      now: chat.app.now.value,
    });
    await team(chat, "shared", [chat.memberId, other.id]);
    await team(chat, "theirs", [other.id]);
    await team(chat, "mine", [chat.memberId]);
    // made last, listed first: the projects read by name
    await team(chat, "also", [chat.memberId, other.id]);
    const names = async (client: ChatApp["member"], username: string) => {
      const body: DirectoryUserResponse = await (
        await client.call("GET", `/api/directory/users/${username}`)
      ).json();
      return body.projects.map((p) => p.name);
    };
    expect(await names(chat.member, "bogdan")).toEqual(["also", "shared"]);
    // an admin opens every team, so shares all of bogdan's
    expect(await names(chat.admin, "bogdan")).toEqual([
      "also",
      "shared",
      "theirs",
    ]);
    // and a member shares all of theirs with an admin, none of the rest
    expect(await names(chat.member, "admin")).toEqual([
      "also",
      "mine",
      "shared",
    ]);
    expect(await names(chat.admin, "admin")).toEqual([
      "also",
      "mine",
      "shared",
      "theirs",
    ]);
    // your own page is your team projects, never the personal one
    expect(await names(chat.member, "casey")).toEqual([
      "also",
      "mine",
      "shared",
    ]);
  });

  test("a disabled user's page still opens, marked disabled", async () => {
    const chat = await chatApp();
    chat.app.users.setDisabled(chat.memberId, true);
    const body: DirectoryUserResponse = await (
      await chat.admin.call("GET", "/api/directory/users/casey")
    ).json();
    expect(body.user.disabled).toBe(true);
  });

  test("an agent's page names its provider and the tools a send gets", async () => {
    const chat = await chatApp();
    const res = await chat.member.call("GET", "/api/directory/agents/coder");
    expect(res.status).toBe(200);
    const body: DirectoryAgentResponse = await res.json();
    expect(body.agent.id).toBe(chat.agentId);
    expect(body.provider).toBe("local");
    expect(body.skills).toEqual([]);
    expect(
      body.tools.map(({ name, provider }) => ({ name, provider })),
    ).toEqual([
      // by name, not in the order a send offers them
      { name: "bash", provider: null },
      { name: "datetime", provider: null },
      { name: "memory_edit", provider: null },
      { name: "visualize", provider: null },
      { name: "webfetch", provider: null },
    ]);
    // the agent has no prompt and no skills; the tool schemas cost,
    // and no MCP server is offered
    expect(body.mcp).toEqual({ servers: [], tokens: 0 });
    expect(body.tokens.prompt).toBe(0);
    expect(body.tokens.skills).toBe(0);
    expect(body.tokens.tools).toBeGreaterThan(50);
    const started = await startChat(chat);
    const offered = chat.app.runner.registry.get(started.sessionId)!.policy
      .offered.tools;
    expect(body.tokens.tools).toBe(wireTokens(offered));
    // each with the description the model reads
    for (const tool of body.tools) {
      expect(tool.description).toBe(
        offered.find((t) => t.name === tool.name)!.description,
      );
    }
    const catalogResponse = await chat.admin.call("GET", "/api/tools");
    expect(catalogResponse.status).toBe(200);
    const catalog: ToolsResponse = await catalogResponse.json();
    const bash = catalog.builtin.find((tool) => tool.name === "bash")!;
    expect(bash.tokens).toBe(449);
    expect(bash.tokens).toBe(
      wireTokens(offered.filter((tool) => tool.name === "bash")),
    );
    expect(bash.description).toBe(
      offered.find((tool) => tool.name === "bash")!.description,
    );
    expect(
      body.tokens.tools -
        wireTokens(offered.filter((tool) => tool.name !== "bash")),
    ).toBeGreaterThan(0);
    started.script.reply("done");
    const off = await chat.admin.call("PATCH", "/api/tools/web", {
      body: { mode: "off" },
    });
    expect(off.status).toBe(200);
    const after: DirectoryAgentResponse = await (
      await chat.member.call("GET", "/api/directory/agents/coder")
    ).json();
    expect(after.tools.map((t) => t.name)).toEqual([
      "bash",
      "datetime",
      "memory_edit",
      "visualize",
    ]);
    // one schema fewer on the wire, fewer tokens
    expect(after.tokens.tools).toBeLessThan(body.tokens.tools);
    const search = await chat.admin.call("PATCH", "/api/tools/websearch", {
      body: { provider: "exa" },
    });
    expect(search.status).toBe(200);
    expect(
      (
        await chat.admin.call("PATCH", "/api/tools/web", {
          body: { mode: "all" },
        })
      ).status,
    ).toBe(200);
    const searching: DirectoryAgentResponse = await (
      await chat.member.call("GET", "/api/directory/agents/coder")
    ).json();
    expect(searching.tools.find((t) => t.name === "websearch")?.provider).toBe(
      "exa",
    );
    expect(
      (await chat.member.call("GET", "/api/directory/agents/nobody")).status,
    ).toBe(404);
  });

  test("malformed names are the parser's 400, a well formed stranger a 404", async () => {
    const chat = await chatApp();
    for (const path of [
      "/api/directory/users/A%20B",
      "/api/directory/users/ab",
      "/api/directory/agents/Coder",
      "/api/directory/agents/a.b",
    ]) {
      expect((await chat.member.call("GET", path)).status).toBe(400);
    }
    expect(
      (await chat.member.call("GET", "/api/directory/users/stranger")).status,
    ).toBe(404);
  });

  test("an agent's skills carry their descriptions, fetch times and files, and every schema counts", async () => {
    const chat = await chatApp();
    const bare: DirectoryAgentResponse = await (
      await chat.member.call("GET", "/api/directory/agents/coder")
    ).json();
    const now = chat.app.now.value;
    const plain = chat.app.skills.create(
      loaded("plain", "Do the plain thing."),
      now,
    );
    chat.app.now.value = now + 60_000;
    const filed = chat.app.skills.create(
      loaded("filed", "Read the runbook first.", [
        { path: "references/runbook.md", content: "steps", bytes: 5 },
      ]),
      chat.app.now.value,
    );
    chat.app.skills.assign(chat.agentId, [plain.id, filed.id]);
    const body: DirectoryAgentResponse = await (
      await chat.member.call("GET", "/api/directory/agents/coder")
    ).json();
    expect(body.skills).toEqual([
      {
        id: filed.id,
        name: "filed",
        description: "Use filed.",
        hasFiles: true,
        fetchedAt: now + 60_000,
        // SKILL.md and the runbook
        files: 2,
      },
      {
        id: plain.id,
        name: "plain",
        description: "Use plain.",
        hasFiles: false,
        fetchedAt: now,
        files: 1,
      },
    ]);
    // the skill tools are left out of the list, never out of the count
    expect(body.tools.map((t) => t.name)).toEqual([
      "bash",
      "datetime",
      "memory_edit",
      "visualize",
      "webfetch",
    ]);
    expect(body.tokens.tools).toBeGreaterThan(bare.tokens.tools);
    expect(body.tokens.skills).toBe(
      tokens("Read the runbook first.") + tokens("Do the plain thing."),
    );
    const sent = await (
      await chat.member.call("GET", "/api/directory/agents/coder")
    ).json();
    expect(sent.tokens).toEqual(body.tokens);
    // a refreshed body moves the digest, and the count follows
    chat.app.skills.replace(
      plain.id,
      loaded("plain", "Do the plain thing, now with more words in it."),
      null,
      chat.app.now.value,
    );
    const after: DirectoryAgentResponse = await (
      await chat.member.call("GET", "/api/directory/agents/coder")
    ).json();
    expect(after.tokens.skills).toBe(
      tokens("Read the runbook first.") +
        tokens("Do the plain thing, now with more words in it."),
    );
  });

  test("an agent whose model takes no tools is offered none", async () => {
    const chat = await chatApp();
    await chat.makeAgent({ name: "plain", model: NO_TOOLS });
    const body: DirectoryAgentResponse = await (
      await chat.member.call("GET", "/api/directory/agents/plain")
    ).json();
    expect(body.tools).toEqual([]);
    expect(body.tokens.tools).toBe(0);
  });

  test("the prompt's tokens are counted in o200k_base", async () => {
    const chat = await chatApp();
    const res = await chat.admin.call("PATCH", `/api/agents/${chat.agentId}`, {
      body: {
        name: "coder",
        providerId: chat.providerId,
        model: FLASH,
        thinking: null,
        effort: null,
        prompt: "You write code. Keep diffs small.",
        servers: [],
        mcpMode: "auto",
      },
    });
    expect(res.status).toBe(200);
    const body: DirectoryAgentResponse = await (
      await chat.member.call("GET", "/api/directory/agents/coder")
    ).json();
    expect(body.tokens.prompt).toBe(
      tokens("You write code. Keep diffs small."),
    );
  });
});
