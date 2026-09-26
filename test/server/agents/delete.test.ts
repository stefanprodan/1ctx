// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import type { OverviewResponse } from "../../../src/shared/api/admin.ts";
import type { AgentImpactResponse } from "../../../src/shared/api/agents.ts";
import type { ProjectAgentsResponse } from "../../../src/shared/api/sessions.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { PROVIDER_URL } from "../../helpers/app.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  FLASH,
  startChat,
  tick,
} from "../../helpers/chat.ts";

const skill = (name: string) => ({
  name,
  description: `Use ${name}.`,
  body: `Do the ${name} thing.`,
  license: "",
  compatibility: "",
  metadata: {},
  allowedTools: "",
  sourceKind: "file" as const,
  sourceUrl: `https://skills.test/${name}/SKILL.md`,
  sourceSelect: "",
  sourceDigest: "",
  digest: `sha256:${name}`,
  dropped: [],
  droppedMore: 0,
  files: [],
});

function server(chat: ChatApp) {
  return chat.app.mcp.create(
    {
      name: "cluster",
      url: "http://cluster.test/mcp",
      keyName: null,
      read: true,
      write: false,
      instructionsOn: true,
      timeoutMs: null,
      readPatterns: ["*"],
      writePatterns: [],
      excludedPatterns: [],
    },
    {
      serverName: "cluster",
      serverVersion: "1",
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
      instructions: "",
      fingerprint: "fingerprint",
      checkedAt: chat.app.now.value,
      tools: [],
    },
  );
}

const agentBody = (name: string, providerId: string) => ({
  name,
  providerId,
  model: FLASH,
  thinking: null,
  effort: null,
  servers: [],
  mcpMode: "auto",
});

async function settle(chat: ChatApp, sessionId: string) {
  const session = await settleRun(chat, sessionId);
  await tick();
  return session;
}

async function detail(chat: ChatApp, id: string): Promise<SessionDetail> {
  const res = await chat.member.call("GET", `/api/sessions/${id}`);
  expect(res.status).toBe(200);
  return res.json();
}

async function impact(chat: ChatApp): Promise<AgentImpactResponse> {
  const res = await chat.admin.call(
    "GET",
    `/api/agents/${chat.agentId}/impact`,
  );
  expect(res.status).toBe(200);
  return res.json();
}

describe("deleting an agent", () => {
  test.serial(
    "retires it, archives its chats, pauses its automations and blocks nothing",
    async () => {
      const chat = await chatApp();
      chat.app.automationScheduler.stop();
      const { app } = chat;
      // a second provider, so the first can go once coder is retired
      const { provider: spare } = await (
        await chat.admin.call("POST", "/api/providers", {
          body: {
            name: "spare",
            wire: "openai-compatible",
            baseUrl: PROVIDER_URL,
            keyName: null,
          },
        })
      ).json();
      const helper = await chat.admin.call("POST", "/api/agents", {
        body: agentBody("helper", spare.id),
      });
      expect(helper.status).toBe(201);
      const helperId = (await helper.json()).agent.id as string;
      app.agents.setDefault(chat.agentId, true);
      const loaded = app.skills.create(skill("gitops"), app.now.value);
      app.skills.assign(chat.agentId, [loaded.id]);
      const cluster = server(chat);
      app.mcp.setAgentServers(chat.agentId, [
        { serverId: cluster.id, read: true, write: false },
      ]);
      expect(
        (
          await chat.member.call("PUT", "/api/profile/agent", {
            body: { agentId: chat.agentId },
          })
        ).status,
      ).toBe(200);

      const first = await startChat(chat, "first");
      first.script.reply("one");
      await settle(chat, first.sessionId);
      const second = await startChat(chat, "second");
      second.script.reply("two");
      await settle(chat, second.sessionId);
      app.db
        .query(
          `insert into session_scratch
             (session_id, cwd, revision, bytes, files, used_at)
           values (?, '/', 1, 0, 0, ?)`,
        )
        .run(first.sessionId, app.now.value);
      const active = await createAutomation(chat, { name: "active" });
      const run = await startRun(chat, active.id);
      run.main.reply("healthy");
      await settle(chat, run.sessionId);
      const paused = await createAutomation(chat, { name: "paused" });
      expect(
        (
          await chat.member.call(
            "POST",
            `/api/automations/${paused.id}/suspend`,
          )
        ).status,
      ).toBe(200);

      expect(await impact(chat)).toEqual({
        chats: 2,
        automations: 1,
        running: 0,
      });

      const events: BusEvent[] = [];
      const unsubscribe = subscribe((event) => events.push(event), silent);
      const deleted = await chat.admin.call(
        "DELETE",
        `/api/agents/${chat.agentId}`,
      );
      unsubscribe();
      expect(deleted.status).toBe(200);

      // the row stays, retired and freed
      const retired = app.db
        .query<
          {
            deleted_at: number | null;
            provider_id: string | null;
            is_default: number;
          },
          [string]
        >("select deleted_at, provider_id, is_default from agents where id = ?")
        .get(chat.agentId)!;
      expect(retired).toEqual({
        deleted_at: app.now.value,
        provider_id: null,
        is_default: 0,
      });
      expect(app.agents.byId(chat.agentId)).toBeNull();
      expect(app.agents.byName("coder")).toBeNull();
      expect(app.agents.list().map((agent) => agent.id)).toEqual([helperId]);
      expect(app.users.byId(chat.memberId)!.agentId).toBeNull();

      // its chats are archived, the run is not; the scratch waits for
      // the sweep, since an archived chat may still run
      for (const id of [first.sessionId, second.sessionId]) {
        const shown = await detail(chat, id);
        expect(shown.session.archived).toEqual({
          at: app.now.value,
          reason: "agent",
        });
        expect(shown.archive).toMatchObject({ by: null });
        expect(shown.agents).toEqual([
          {
            id: chat.agentId,
            name: "coder",
            avatar: expect.any(String),
            retired: true,
          },
        ]);
      }
      expect(app.sessions.byId(run.sessionId)!.archived).toBeNull();
      const scratch = () =>
        app.db.query("select count(*) as n from session_scratch").get() as {
          n: number;
        };
      expect(scratch()).toEqual({ n: 1 });
      app.sweep();
      expect(scratch()).toEqual({ n: 0 });

      // the active automation is paused by the admin, the paused one kept
      expect(app.automations.byId(active.id)).toMatchObject({
        nextAt: null,
        suspendedBy: { id: chat.adminId, username: "admin" },
        agentRetired: true,
        agentName: "coder",
      });
      expect(app.automations.byId(paused.id)!.suspendedBy).toMatchObject({
        id: chat.memberId,
      });

      // one envelope per chat and per paused automation
      const changed = events.flatMap((event) =>
        event.type === "session.changed" ? [event.data.session.id] : [],
      );
      expect(changed.sort()).toEqual(
        [first.sessionId, second.sessionId].sort(),
      );
      expect(
        events.flatMap((event) =>
          event.type === "automation.changed" ? [event.data.automation.id] : [],
        ),
      ).toEqual([active.id]);

      // the default and the member's start move on
      const offered: ProjectAgentsResponse = await (
        await chat.member.call("GET", `/api/projects/${chat.projectId}/agents`)
      ).json();
      expect(offered.startsOn).toBe(helperId);
      expect(offered.agents.map((agent) => agent.id)).toEqual([helperId]);
      expect(app.agents.list()[0]!.default).toBe(true);

      // nothing it held is blocked
      expect(
        (await chat.admin.call("DELETE", `/api/skills/${loaded.id}`)).status,
      ).toBe(200);
      expect(
        (await chat.admin.call("DELETE", `/api/mcp/${cluster.id}`)).status,
      ).toBe(204);
      expect(
        (await chat.admin.call("DELETE", `/api/providers/${chat.providerId}`))
          .status,
      ).toBe(200);
      const twin = await chat.admin.call("POST", "/api/agents", {
        body: agentBody("coder", spare.id),
      });
      expect(twin.status).toBe(201);
      const twinId = (await twin.json()).agent.id as string;
      expect(app.agents.byName("coder")!.id).toBe(twinId);

      // the retired agent's chats still name it, apart from the twin
      const kept = await detail(chat, first.sessionId);
      expect(kept.agents).toEqual([
        expect.objectContaining({ id: chat.agentId, retired: true }),
      ]);
      expect(
        (await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`)).status,
      ).toBe(404);
      expect(
        (await chat.admin.call("GET", `/api/agents/${chat.agentId}/impact`))
          .status,
      ).toBe(404);
      await app.shutdown();
    },
  );

  test("a chat streaming on it ends stopped and archived", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const started = await startChat(chat);
    started.script.content("partial");
    await tick();
    expect(await impact(chat)).toEqual({
      chats: 1,
      automations: 0,
      running: 1,
    });
    expect(
      (await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`)).status,
    ).toBe(200);
    const ended = await settle(chat, started.sessionId);
    expect(started.script.aborted).toBe(true);
    expect(ended).toMatchObject({
      status: "stopped",
      archived: { reason: "agent" },
    });
    expect(chat.app.sessions.lastSend(started.sessionId)).toMatchObject({
      status: "stopped",
      cause: "stop",
    });
    await chat.app.shutdown();
  });

  test("a provider that served chats goes, and the overview keeps its name", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const started = await startChat(chat);
    started.script.reply("done");
    await settle(chat, started.sessionId);
    expect(
      (await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`)).status,
    ).toBe(200);
    expect(
      (await chat.admin.call("DELETE", `/api/providers/${chat.providerId}`))
        .status,
    ).toBe(200);
    const res = await chat.admin.call("GET", "/api/admin/overview?tz=UTC");
    expect(res.status).toBe(200);
    const body: OverviewResponse = await res.json();
    expect(body.lengths).toEqual([
      expect.objectContaining({ provider: "local", model: FLASH, turns: 1 }),
    ]);
    expect(body.instance.agents).toBe(0);
    await chat.app.shutdown();
  });
});

describe("an automation on a retired agent", () => {
  test("resume, an edit that keeps the agent and run now are 409s until a live pick", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const helperId = await chat.makeAgent({ name: "helper", model: FLASH });
    const automation = await createAutomation(chat);
    expect(
      (await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`)).status,
    ).toBe(200);
    const refused = [
      await chat.member.call(
        "POST",
        `/api/automations/${automation.id}/resume`,
      ),
      await chat.member.call("PATCH", `/api/automations/${automation.id}`, {
        body: { name: "renamed" },
      }),
      await chat.member.call("POST", `/api/automations/${automation.id}/run`),
    ];
    for (const res of refused) {
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "its agent was deleted" });
    }
    expect(chat.app.automations.byId(automation.id)).toMatchObject({
      name: "daily-run",
      nextAt: null,
    });
    const moved = await chat.member.call(
      "PATCH",
      `/api/automations/${automation.id}`,
      { body: { agentId: helperId } },
    );
    expect(moved.status).toBe(200);
    expect((await moved.json()).automation).toMatchObject({
      agentId: helperId,
      agentRetired: false,
      suspendedBy: { id: chat.adminId },
    });
    expect(
      (
        await chat.member.call(
          "POST",
          `/api/automations/${automation.id}/resume`,
        )
      ).status,
    ).toBe(200);
    expect(chat.app.automations.byId(automation.id)!.nextAt).not.toBeNull();
    await chat.app.shutdown();
  });
});
