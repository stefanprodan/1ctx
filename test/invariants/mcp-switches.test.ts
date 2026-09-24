// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../src/server/lib/bus.ts";
import { type LogFactory, silent } from "../../src/server/lib/log.ts";
import type { ProjectAgentsResponse } from "../../src/shared/api/sessions.ts";
import {
  type CapabilityChange,
  mcpKey,
  mcpOffLine,
  WEB_OFF_LINE,
} from "../../src/shared/capabilities.ts";
import type { AgentServer } from "../../src/shared/contracts/mcp.ts";
import type { SessionDetail } from "../../src/shared/contracts/session.ts";
import { CATALOG_LEAD } from "../../src/shared/mcp.ts";
import type { McpMode } from "../../src/shared/words.ts";
import { collectLogs } from "../helpers/app.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  FLASH,
  NO_TOOLS,
  type Script,
  startChat,
  waitScript,
} from "../helpers/chat.ts";
import { link, seedServer } from "../server/mcp/switches.helpers.ts";

async function assign(
  chat: ChatApp,
  servers: AgentServer[],
  mcpMode: McpMode = "catalog",
) {
  const agent = chat.app.agents.byId(chat.agentId)!;
  const response = await chat.admin.call("PATCH", `/api/agents/${agent.id}`, {
    body: {
      name: agent.name,
      providerId: agent.providerId,
      model: agent.model.id,
      thinking: agent.thinking,
      effort: agent.effort,
      prompt: "Answer carefully.",
      servers,
      mcpMode,
    },
  });
  expect(response.status, await response.text()).toBe(200);
}

async function setup(model?: string, logFactory?: LogFactory) {
  const chat = await chatApp({ model, logFactory });
  chat.app.automationScheduler.stop();
  const flux = seedServer(chat.app.mcp, "flux");
  const docs = seedServer(chat.app.mcp, "docs");
  await assign(chat, [link(flux), link(docs)]);
  return { chat, flux, docs };
}

const system = (script: Script) =>
  (script.body.messages as { role: string; content: string }[])[0]!.content;

async function send(
  chat: ChatApp,
  sessionId: string | null,
  capabilities?: CapabilityChange,
) {
  const count = chat.scripted.scripts.length + 1;
  const response = await chat.member.call(
    "POST",
    sessionId === null
      ? "/api/sessions"
      : `/api/sessions/${sessionId}/messages`,
    {
      body: {
        ...(sessionId === null
          ? { projectId: chat.projectId, agentId: chat.agentId }
          : {}),
        message: "Continue.",
        capabilities,
      },
    },
  );
  expect(response.status).toBe(201);
  const detail = (await response.json()) as SessionDetail;
  const script = await waitScript(chat.scripted, count);
  const policy = chat.app.runner.registry.get(detail.session.id)!.policy;
  return { detail, script, policy };
}

test.serial(
  "an MCP flip shares the start revision and its note fires only once",
  async () => {
    const { chat, flux } = await setup();
    const events: Extract<BusEvent, { type: "session.changed" }>[] = [];
    const unsubscribe = subscribe((event) => {
      if (
        event.type === "session.changed" &&
        event.data.session.projectId === chat.projectId
      ) {
        events.push(event);
      }
    }, silent);
    try {
      const first = await startChat(chat);
      const on = system(first.script);
      first.script.reply("First answer.");
      await settleRun(chat, first.sessionId);
      const before = chat.app.sessions.byId(first.sessionId)!;
      events.length = 0;
      const flipped = await send(chat, first.sessionId, {
        disable: ["web", mcpKey(flux.id)],
      });
      expect(flipped.detail.session.disabledCapabilities).toEqual([
        mcpKey(flux.id),
        "web",
      ]);
      expect(flipped.detail.session.revision).toBe(before.revision + 1);
      expect(events).toHaveLength(1);
      expect(events[0]!.data.session).toEqual(flipped.detail.session);
      expect(events[0]!.data.messages.map((message) => message.kind)).toEqual([
        "user",
        "reply",
      ]);
      expect(flipped.policy.mcpOff).toEqual(["flux"]);
      const off = system(flipped.script);
      const line = mcpOffLine(["flux"]);
      expect(off).toContain(
        `${WEB_OFF_LINE}\n\n${line}\n\nSince your last turn`,
      );
      expect(off.indexOf("Today is ")).toBeLessThan(off.indexOf(WEB_OFF_LINE));
      expect(off).toContain("- flux: no longer available");
      expect(on.indexOf(CATALOG_LEAD)).toBeGreaterThan(0);
      expect(off.indexOf(CATALOG_LEAD)).toBeGreaterThan(0);
      expect(off.slice(0, off.indexOf(CATALOG_LEAD))).toBe(
        on.slice(0, on.indexOf(CATALOG_LEAD)),
      );
      flipped.script.reply("Without flux.");
      await settleRun(chat, first.sessionId);
      const next = await send(chat, first.sessionId);
      expect(next.policy.mcpOff).toEqual(["flux"]);
      expect(system(next.script)).toContain(line);
      expect(system(next.script)).not.toContain("Since your last turn");
      expect(next.script.body.tools).toEqual(flipped.script.body.tools);
      expect(next.policy.offered.mcpPrompt).toEqual(
        flipped.policy.offered.mcpPrompt,
      );
      next.script.reply("Still without flux.");
      await settleRun(chat, first.sessionId);

      const beforeRegen = chat.app.sessions.byId(first.sessionId)!;
      const response = await chat.member.call(
        "POST",
        `/api/sessions/${first.sessionId}/regenerate`,
        { body: { capabilities: { enable: [mcpKey(flux.id)] } } },
      );
      expect(response.status).toBe(201);
      expect((await response.json()).session).toMatchObject({
        revision: beforeRegen.revision + 1,
        disabledCapabilities: ["web"],
      });
      const regenerated = await waitScript(chat.scripted, 4);
      const active = chat.app.runner.registry.get(first.sessionId)!.policy;
      expect(active.mcpOff).toEqual([]);
      expect(Object.keys(active.offered.mcpPrompt.digest)).toEqual([
        "docs",
        "flux",
      ]);
      expect(system(regenerated)).toContain("- flux: now available");
      expect(system(regenerated)).not.toContain(line);
      regenerated.reply("With flux again.");
      await settleRun(chat, first.sessionId);
    } finally {
      unsubscribe();
      await chat.app.shutdown();
      chat.app.db.close();
    }
  },
);

test("a chat fork keeps MCP keys even on an agent without their servers", async () => {
  const { chat, flux, docs } = await setup();
  try {
    const keys = [mcpKey(flux.id), mcpKey(docs.id)].sort();
    const first = await send(chat, null, { disable: keys });
    expect(first.policy.mcpOff).toEqual(["docs", "flux"]);
    expect(system(first.script)).toContain(mcpOffLine(["docs", "flux"]));
    first.script.reply("No servers.");
    const id = first.detail.session.id;
    await settleRun(chat, id);
    const reply = chat.app.sessions
      .messages(id)
      .findLast((message) => message.kind === "reply")!;
    const plain = await chat.makeAgent({ name: "plain", model: FLASH });
    const response = await chat.member.call(
      "POST",
      `/api/sessions/${id}/fork`,
      {
        body: { messageId: reply.id, agentId: plain },
      },
    );
    expect(response.status).toBe(201);
    const fork = (await response.json()) as SessionDetail;
    expect(fork.session.disabledCapabilities).toEqual(keys);
    const next = await send(chat, fork.session.id);
    expect(next.policy.disabledCapabilities).toEqual(keys);
    expect(next.policy.mcpOff).toEqual([]);
    expect(system(next.script)).not.toContain("turned these MCP servers off");
    expect(next.policy.offered.mcp).toEqual([]);
    next.script.reply("No linked servers.");
    await settleRun(chat, fork.session.id);
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test("the off line ignores missing, unassigned and otherwise-unoffered servers", async () => {
  const { chat, flux, docs } = await setup();
  try {
    const other = seedServer(chat.app.mcp, "other");
    chat.app.mcp.updateSettings(docs.id, { excludedPatterns: ["*"] });
    const first = await send(chat, null, {
      disable: [
        mcpKey(flux.id),
        mcpKey(docs.id),
        mcpKey(other.id),
        mcpKey("gone"),
      ],
    });
    expect(first.policy.mcpOff).toEqual(["flux"]);
    expect(system(first.script)).toContain(mcpOffLine(["flux"]));
    await assign(chat, [link(docs)]);
    expect(first.policy.mcpOff).toEqual(["flux"]);
    first.script.reply("Without flux.");
    await settleRun(chat, first.detail.session.id);
    const next = await send(chat, first.detail.session.id);
    expect(next.policy.disabledCapabilities).toEqual(
      first.policy.disabledCapabilities,
    );
    expect(next.policy.mcpOff).toEqual([]);
    expect(system(next.script)).not.toContain("turned these MCP servers off");
    next.script.reply("None offered anyway.");
    await settleRun(chat, first.detail.session.id);
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test("a no-tools model keeps its MCP keys without an off line", async () => {
  const { chat, flux } = await setup(NO_TOOLS);
  try {
    const first = await send(chat, null, { disable: [mcpKey(flux.id)] });
    expect(first.detail.session.disabledCapabilities).toEqual([
      mcpKey(flux.id),
    ]);
    expect(first.policy.mcpOff).toEqual([]);
    expect(first.script.body.tools).toBeUndefined();
    expect(system(first.script)).not.toContain("turned these MCP servers off");
    first.script.reply("No tools.");
    await settleRun(chat, first.detail.session.id);
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test.each(["manual", "schedule"] as const)(
  "%s runs snapshot the automation MCP set and forks copy the snapshot",
  async (source) => {
    const { chat, flux } = await setup();
    try {
      const keys = [mcpKey(flux.id), "web"];
      const automation = await createAutomation(chat, {
        disabledCapabilities: keys,
      });
      const run =
        source === "manual"
          ? await startRun(chat, automation.id)
          : await (async () => {
              chat.app.db
                .query("update automations set next_at = ? where id = ?")
                .run(chat.app.now.value, automation.id);
              const detail = await chat.app.automationScheduler.fire(
                automation.id,
              );
              expect(detail).not.toBeNull();
              return {
                sessionId: detail!.session.id,
                main: await waitScript(chat.scripted, 1),
              };
            })();
      const policy = chat.app.runner.registry.get(run.sessionId)!.policy;
      expect(policy.disabledCapabilities).toEqual(keys);
      expect(policy.mcpOff).toEqual(["flux"]);
      expect(policy.offered.mcp.map((server) => server.name)).toEqual(["docs"]);
      expect(system(run.main)).toContain(mcpOffLine(["flux"]));
      expect(
        chat.app.sessions.byId(run.sessionId)?.disabledCapabilities,
      ).toEqual(keys);
      const changed = await chat.member.call(
        "PATCH",
        `/api/automations/${automation.id}`,
        {
          body: { disabledCapabilities: [] },
        },
      );
      expect(changed.status).toBe(200);
      expect(policy.disabledCapabilities).toEqual(keys);
      run.main.reply("Task done.");
      await settleRun(chat, run.sessionId);
      const reply = chat.app.sessions
        .messages(run.sessionId)
        .findLast((message) => message.kind === "reply")!;
      const fork = await chat.member.call(
        "POST",
        `/api/sessions/${run.sessionId}/fork`,
        {
          body: { messageId: reply.id, agentId: chat.agentId },
        },
      );
      expect(fork.status).toBe(201);
      expect((await fork.json()).session.disabledCapabilities).toEqual(keys);
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  },
);

test("project agents expose the same switchable map to members and admins", async () => {
  const { chat, flux, docs } = await setup();
  try {
    const plain = await chat.makeAgent({ name: "plain", model: FLASH });
    const noTools = await chat.makeAgent({ name: "no-tools", model: NO_TOOLS });
    const empty = seedServer(chat.app.mcp, "empty", 0);
    const excluded = seedServer(chat.app.mcp, "excluded");
    chat.app.mcp.updateSettings(excluded.id, { excludedPatterns: ["*"] });
    await assign(chat, [link(flux), link(excluded), link(docs), link(empty)]);
    chat.app.mcp.setAgentServers(plain, [link(empty), link(excluded)]);
    chat.app.mcp.setAgentServers(noTools, [link(flux)]);
    const created = await chat.admin.call("POST", "/api/projects", {
      body: { name: "team" },
    });
    expect(created.status).toBe(201);
    const { project } = await created.json();
    expect(
      (
        await chat.admin.call("POST", `/api/projects/${project.id}/members`, {
          body: { userId: chat.memberId },
        })
      ).status,
    ).toBe(201);
    const path = `/api/projects/${project.id}/agents`;
    const admin = await chat.admin.call("GET", path);
    const member = await chat.member.call("GET", path);
    expect(admin.status).toBe(200);
    expect(member.status).toBe(200);
    const body = (await member.json()) as ProjectAgentsResponse;
    expect(body).toEqual(await admin.json());
    expect(body.servers).toEqual({
      [chat.agentId]: [
        { id: docs.id, name: "docs", tools: 1 },
        { id: flux.id, name: "flux", tools: 1 },
      ],
      [noTools]: [{ id: flux.id, name: "flux", tools: 1 }],
    });
    expect(body.servers).not.toHaveProperty(plain);
    expect(body.capabilities).toEqual(["web", "visualize", "memory"]);
    chat.app.mcp.updateSettings(flux.id, { read: false });
    chat.app.mcp.updateSettings(docs.id, { read: false });
    expect(
      (await (await chat.member.call("GET", path)).json()).servers,
    ).toEqual({});
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test.serial(
  "server deletion forgets only its key atomically, without revisions or events",
  async () => {
    const logs = collectLogs();
    const { chat, flux, docs } = await setup(undefined, logs.logFactory);
    const events: BusEvent[] = [];
    let unsubscribe = () => {};
    try {
      const key = mcpKey(flux.id);
      const sets = [[key, mcpKey(docs.id), "web"].sort(), [key], ["web"], []];
      const chats = sets.map((disabledCapabilities) =>
        chat.app.sessions.create({
          projectId: chat.projectId,
          ownerId: chat.memberId,
          agentId: chat.agentId,
          title: "Stored chat",
          now: chat.app.now.value,
          status: "done",
          disabledCapabilities,
        }),
      );
      const tasks = await Promise.all(
        sets.map((disabledCapabilities, i) =>
          createAutomation(chat, { name: `task-${i}`, disabledCapabilities }),
        ),
      );
      unsubscribe = subscribe((event) => events.push(event), silent);
      expect(
        (await chat.admin.call("DELETE", `/api/mcp/${flux.id}`)).status,
      ).toBe(409);
      expect(chat.app.sessions.byId(chats[0]!.id)).toEqual(chats[0]);
      expect(chat.app.automations.byId(tasks[0]!.id)).toEqual(tasks[0]);
      await assign(chat, [link(docs)]);
      expect(chat.app.sessions.byId(chats[0]!.id)).toEqual(chats[0]);
      expect(chat.app.automations.byId(tasks[0]!.id)).toEqual(tasks[0]);
      const forget = chat.app.automations.forgetCapability.bind(
        chat.app.automations,
      );
      chat.app.automations.forgetCapability = (key) => {
        forget(key);
        throw new Error("forget failed");
      };
      try {
        const response = await chat.admin.call("DELETE", `/api/mcp/${flux.id}`);
        expect(response.status).toBe(500);
        expect(
          logs.events.findLast((event) => event.level === "error"),
        ).toMatchObject({
          area: "router",
          msg: "request",
          fields: {
            route: "/api/mcp/:id",
            status: 500,
            error: "forget failed",
          },
        });
      } finally {
        chat.app.automations.forgetCapability = forget;
      }
      expect(chat.app.mcp.byId(flux.id)).toEqual(flux);
      for (const row of chats)
        expect(chat.app.sessions.byId(row.id)).toEqual(row);
      for (const row of tasks)
        expect(chat.app.automations.byId(row.id)).toEqual(row);
      expect(events).toEqual([]);
      expect(
        (await chat.admin.call("DELETE", `/api/mcp/${flux.id}`)).status,
      ).toBe(204);
      expect(chat.app.mcp.byId(flux.id)).toBeNull();
      for (const row of chats) {
        expect(chat.app.sessions.byId(row.id)).toEqual({
          ...row,
          disabledCapabilities: row.disabledCapabilities.filter(
            (item) => item !== key,
          ),
        });
      }
      for (const row of tasks) {
        expect(chat.app.automations.byId(row.id)).toEqual({
          ...row,
          disabledCapabilities: row.disabledCapabilities.filter(
            (item) => item !== key,
          ),
        });
      }
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
      await chat.app.shutdown();
      chat.app.db.close();
    }
  },
);
