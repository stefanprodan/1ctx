// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  mcpOffLine,
  VISUALIZE,
  VISUALIZE_OFF_LINE,
  WEB_OFF_LINE,
} from "../../../src/shared/capabilities.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { chatApp, tick, waitScript } from "../../helpers/chat.ts";

async function settled(chat: Awaited<ReturnType<typeof chatApp>>, id: string) {
  for (let i = 0; i < 200; i++) {
    if (chat.app.sessions.byId(id)?.status !== "running") return;
    await tick();
  }
  throw new Error("send did not settle");
}

async function create(
  chat: Awaited<ReturnType<typeof chatApp>>,
  capabilities?: { disable?: string[]; enable?: string[] },
) {
  const response = await chat.member.call("POST", "/api/sessions", {
    body: {
      projectId: chat.projectId,
      agentId: chat.agentId,
      message: "hello",
      capabilities,
    },
  });
  expect(response.status).toBe(201);
  return (await response.json()) as SessionDetail;
}

describe("the chat's visualize switch", () => {
  test("removes the tool and only the tool, with the line in its place", async () => {
    const chat = await chatApp();
    try {
      const detail = await create(chat, { disable: [VISUALIZE, "web"] });
      const script = await waitScript(chat.scripted, 1);
      expect(detail.session.disabledCapabilities).toEqual(["visualize", "web"]);
      const active = chat.app.runner.registry.get(detail.session.id)!;
      const names = active.policy.offered.tools.map((tool) => tool.name);
      expect(names).not.toContain("visualize");
      expect(names).toContain("bash");
      expect(names).toContain("datetime");
      // the admin's row is still on: open draws HTML as a visual
      expect(active.policy.offered.visuals).toBe(true);
      const prompt = (script.body.messages as { content: string }[])[0]!
        .content;
      const web = prompt.indexOf(WEB_OFF_LINE);
      const visual = prompt.indexOf(VISUALIZE_OFF_LINE);
      expect(web).toBeGreaterThan(0);
      expect(visual).toBeGreaterThan(web);
      expect(prompt).not.toContain(mcpOffLine([]).slice(0, 20));
      script.reply("done");
      await settled(chat, detail.session.id);
      // an enable brings the tool back and drops the line
      const sent = await chat.member.call(
        "POST",
        `/api/sessions/${detail.session.id}/messages`,
        { body: { message: "again", capabilities: { enable: [VISUALIZE] } } },
      );
      expect(sent.status).toBe(201);
      const second = await waitScript(chat.scripted, 2);
      const again = chat.app.runner.registry.get(detail.session.id)!;
      expect(again.policy.disabledCapabilities).toEqual(["web"]);
      expect(again.policy.offered.tools.map((tool) => tool.name)).toContain(
        "visualize",
      );
      expect(JSON.stringify(second.body.messages)).not.toContain(
        VISUALIZE_OFF_LINE,
      );
      second.reply("done");
      await settled(chat, detail.session.id);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the admin's row off keeps the key, means nothing, and the route says so", async () => {
    const chat = await chatApp();
    try {
      const before = await chat.member.call(
        "GET",
        `/api/projects/${chat.projectId}/agents`,
      );
      expect((await before.json()).capabilities).toEqual(["web", "visualize"]);
      const off = await chat.admin.call("PATCH", "/api/tools/visualize", {
        body: { enabled: false },
      });
      expect(off.status).toBe(200);
      const after = await chat.member.call(
        "GET",
        `/api/projects/${chat.projectId}/agents`,
      );
      expect((await after.json()).capabilities).toEqual(["web"]);
      const detail = await create(chat, { disable: [VISUALIZE] });
      const script = await waitScript(chat.scripted, 1);
      expect(detail.session.disabledCapabilities).toEqual(["visualize"]);
      const active = chat.app.runner.registry.get(detail.session.id)!;
      expect(active.policy.offered.visuals).toBe(false);
      expect(
        active.policy.offered.tools.map((tool) => tool.name),
      ).not.toContain("visualize");
      expect(JSON.stringify(script.body.messages)).toContain(
        VISUALIZE_OFF_LINE,
      );
      script.reply("done");
      await settled(chat, detail.session.id);
    } finally {
      await chat.app.shutdown();
    }
  });
});
