// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../src/server/lib/bus.ts";
import { type LogFactory, silent } from "../../src/server/lib/log.ts";
import type { LoadedSkill } from "../../src/server/skills/index.ts";
import type { ProjectAgentsResponse } from "../../src/shared/api/sessions.ts";
import {
  type CapabilityChange,
  skillKey,
  skillsOffLine,
  WEB_OFF_LINE,
} from "../../src/shared/capabilities.ts";
import type { SessionDetail } from "../../src/shared/contracts/session.ts";
import { CATALOG_LEAD } from "../../src/shared/skills.ts";
import { collectLogs } from "../helpers/app.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  NO_TOOLS,
  type Script,
  waitScript,
} from "../helpers/chat.ts";

const loaded = (name: string, files: LoadedSkill["files"] = []) => ({
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
  files,
});

async function setup(model?: string, logFactory?: LogFactory) {
  const chat = await chatApp({ model, logFactory });
  chat.app.automationScheduler.stop();
  const gitops = chat.app.skills.create(
    loaded("gitops", [{ path: "runbook.md", content: "Step one.", bytes: 9 }]),
    chat.app.now.value,
  );
  const plain = chat.app.skills.create(loaded("plain"), chat.app.now.value);
  chat.app.skills.assign(chat.agentId, [gitops.id, plain.id]);
  return { chat, gitops, plain };
}

const system = (script: Script) =>
  (script.body.messages as { role: string; content: string }[])[0]!.content;

type WireTool = {
  function: { name: string; parameters: { properties: { name: unknown } } };
};
const tool = (script: Script, name: string) =>
  (script.body.tools as WireTool[] | undefined)?.find(
    (item) => item.function.name === name,
  );

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

test("a skill off leaves the catalog, the tool names and the file tool", async () => {
  const { chat, gitops, plain } = await setup();
  try {
    const on = await send(chat, null);
    expect(on.policy.skillsOff).toEqual([]);
    expect(system(on.script)).toContain("<name>gitops</name>");
    expect(
      tool(on.script, "skill")!.function.parameters.properties.name,
    ).toMatchObject({ enum: ["gitops", "plain"] });
    expect(tool(on.script, "skill_file")).toBeDefined();
    on.script.reply("First.");
    const id = on.detail.session.id;
    await settleRun(chat, id);

    // the one skill with files goes, and the file tool with it
    const off = await send(chat, id, {
      disable: ["web", skillKey(gitops.id)],
    });
    expect(off.detail.session.disabledCapabilities).toEqual([
      skillKey(gitops.id),
      "web",
    ]);
    expect(off.policy.skillsOff).toEqual(["gitops"]);
    expect(off.policy.offered.skills.skills.map((s) => s.name)).toEqual([
      "plain",
    ]);
    const prompt = system(off.script);
    expect(prompt).not.toContain("<name>gitops</name>");
    expect(prompt).toContain("<name>plain</name>");
    expect(prompt).toContain(`${WEB_OFF_LINE}\n\n${skillsOffLine(["gitops"])}`);
    expect(prompt.endsWith(skillsOffLine(["gitops"]))).toBe(true);
    // the bytes before the skills catalog do not move with a flip
    expect(prompt.slice(0, prompt.indexOf(CATALOG_LEAD))).toBe(
      system(on.script).slice(0, system(on.script).indexOf(CATALOG_LEAD)),
    );
    expect(
      tool(off.script, "skill")!.function.parameters.properties.name,
    ).toMatchObject({ enum: ["plain"] });
    expect(tool(off.script, "skill_file")).toBeUndefined();
    off.script.reply("Second.");
    await settleRun(chat, id);

    // every skill off: no block and no tool
    const none = await send(chat, id, { disable: [skillKey(plain.id)] });
    expect(none.policy.skillsOff).toEqual(["gitops", "plain"]);
    expect(system(none.script)).not.toContain(CATALOG_LEAD);
    expect(tool(none.script, "skill")).toBeUndefined();
    none.script.reply("Third.");
    await settleRun(chat, id);

    const response = await chat.member.call(
      "POST",
      `/api/sessions/${id}/regenerate`,
      {
        body: {
          capabilities: { enable: [skillKey(gitops.id), skillKey(plain.id)] },
        },
      },
    );
    expect(response.status).toBe(201);
    const again = await waitScript(chat.scripted, 4);
    expect(system(again)).not.toContain("turned these skills off");
    expect(tool(again, "skill_file")).toBeDefined();
    again.reply("Fourth.");
    await settleRun(chat, id);
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test("a key for a skill the agent lacks is kept and changes nothing", async () => {
  const { chat } = await setup();
  try {
    const other = chat.app.skills.create(loaded("other"), chat.app.now.value);
    const keys = [skillKey(other.id), skillKey("gone")].sort();
    const first = await send(chat, null, { disable: keys });
    expect(first.detail.session.disabledCapabilities).toEqual(keys);
    expect(first.policy.skillsOff).toEqual([]);
    expect(system(first.script)).not.toContain("turned these skills off");
    expect(first.policy.offered.skills.skills.map((s) => s.name)).toEqual([
      "gitops",
      "plain",
    ]);
    first.script.reply("Done.");
    await settleRun(chat, first.detail.session.id);
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test("a no-tools model keeps its skill keys without an off line", async () => {
  const { chat, gitops } = await setup(NO_TOOLS);
  try {
    const first = await send(chat, null, { disable: [skillKey(gitops.id)] });
    expect(first.detail.session.disabledCapabilities).toEqual([
      skillKey(gitops.id),
    ]);
    expect(first.policy.skillsOff).toEqual([]);
    expect(system(first.script)).not.toContain("turned these skills off");
    first.script.reply("No tools.");
    await settleRun(chat, first.detail.session.id);
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test("a run takes the automation's skills off", async () => {
  const { chat, gitops } = await setup();
  try {
    const keys = [skillKey(gitops.id)];
    const automation = await createAutomation(chat, {
      disabledCapabilities: keys,
    });
    const run = await startRun(chat, automation.id);
    const policy = chat.app.runner.registry.get(run.sessionId)!.policy;
    expect(policy.skillsOff).toEqual(["gitops"]);
    expect(policy.offered.skills.skills.map((s) => s.name)).toEqual(["plain"]);
    expect(system(run.main)).toContain(skillsOffLine(["gitops"]));
    run.main.reply("Task done.");
    await settleRun(chat, run.sessionId);
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test("project agents answer the skills each agent carries, in name order", async () => {
  const { chat, gitops, plain } = await setup();
  try {
    const created = await chat.admin.call("POST", "/api/projects", {
      body: { name: "team" },
    });
    const { project } = await created.json();
    await chat.admin.call("POST", `/api/projects/${project.id}/members`, {
      body: { userId: chat.memberId },
    });
    const path = `/api/projects/${project.id}/agents`;
    const member = (await (
      await chat.member.call("GET", path)
    ).json()) as ProjectAgentsResponse;
    const admin = (await (
      await chat.admin.call("GET", path)
    ).json()) as ProjectAgentsResponse;
    expect(member.skills).toEqual({
      [chat.agentId]: [
        { id: gitops.id, name: "gitops" },
        { id: plain.id, name: "plain" },
      ],
    });
    expect(admin.skills).toEqual(member.skills);
    chat.app.skills.assign(chat.agentId, []);
    expect((await (await chat.member.call("GET", path)).json()).skills).toEqual(
      {},
    );
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test.serial(
  "skill deletion forgets only its key atomically, without revisions or events",
  async () => {
    const logs = collectLogs();
    const { chat, gitops, plain } = await setup(undefined, logs.logFactory);
    const events: BusEvent[] = [];
    let unsubscribe = () => {};
    try {
      const key = skillKey(gitops.id);
      const sets = [[key, skillKey(plain.id), "web"].sort(), [key], ["web"]];
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
      const path = `/api/skills/${gitops.id}`;
      expect((await chat.admin.call("DELETE", path)).status).toBe(409);
      chat.app.skills.assign(chat.agentId, [plain.id]);
      expect(chat.app.sessions.byId(chats[0]!.id)).toEqual(chats[0]);
      const forget = chat.app.automations.forgetCapability.bind(
        chat.app.automations,
      );
      chat.app.automations.forgetCapability = (k) => {
        forget(k);
        throw new Error("forget failed");
      };
      try {
        const response = await chat.admin.call("DELETE", path);
        expect(response.status).toBe(500);
        expect(
          logs.events.findLast((event) => event.level === "error"),
        ).toMatchObject({
          area: "router",
          msg: "request",
          fields: {
            route: "/api/skills/:id",
            status: 500,
            error: "forget failed",
          },
        });
      } finally {
        chat.app.automations.forgetCapability = forget;
      }
      expect(chat.app.skills.byId(gitops.id)).not.toBeNull();
      for (const row of chats)
        expect(chat.app.sessions.byId(row.id)).toEqual(row);
      for (const row of tasks)
        expect(chat.app.automations.byId(row.id)).toEqual(row);
      expect(events).toEqual([]);
      expect((await chat.admin.call("DELETE", path)).status).toBe(200);
      expect(chat.app.skills.byId(gitops.id)).toBeNull();
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
