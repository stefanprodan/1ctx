// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { parse } from "../../../src/server/provision/index.ts";
import { testApp } from "../../helpers/app.ts";
import {
  agent,
  changes,
  documents,
  fullDocuments,
  INDEX_URL,
  loginCount,
  MCP_URL,
  MODEL_URL,
  mutations,
  network,
  object,
  provider,
  recompose,
  SKILL_URL,
  snapshot,
  user,
} from "./helpers.ts";

async function instance() {
  const fake = network();
  const app = await testApp({
    activate: false,
    fetcher: fake.fetcher,
    secrets: { "user-zed": "test-password", "provider-alternate": "other-key" },
  });
  return { app, fake };
}

const ignore = () => {};

describe("provision through the composed app", () => {
  test("an omitted skill URL does not make path valid on a raw file", async () => {
    const { app } = await instance();
    try {
      await app.provision.apply(
        documents(object("Skill", "paper-skill", { url: SKILL_URL })),
        ignore,
      );
      const docs = parse([
        {
          path: "path-on-file.yaml",
          text: await Bun.file(
            "test/fixtures/provision/path-on-file.yaml",
          ).text(),
        },
      ]);
      const before = app.skills.list();
      await expect(app.provision.apply(docs, ignore)).rejects.toThrow(
        "path-on-file.yaml: Skill/paper-skill: spec.path is only for an archive",
      );
      expect(app.skills.list()).toEqual(before);
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });

  test("creates all kinds in dependency order and reports bootstrap first", async () => {
    const { app, fake } = await instance();
    try {
      expect(app.users.count()).toBe(0);
      const docs = (await fullDocuments()).reverse();
      const lines: string[] = [];
      const counts = await app.provision.apply(docs, (line) =>
        lines.push(line),
      );
      expect(lines[0]).toBe("bootstrapped user/admin from user-admin.key");
      // the bootstrapped admin is not an object in the file, so it is
      // said on its own line and counted nowhere
      expect(counts.created).toBe(6);
      expect(counts.created + counts.updated + counts.unchanged).toBe(
        docs.length,
      );
      const kinds = lines
        .slice(1, -1)
        .map((line) => line.split(" ")[1]?.split("/")[0]);
      expect(kinds).toEqual([
        "user",
        "project",
        "provider",
        "skill",
        "mcpserver",
        "agent",
        "tool",
      ]);
      const zed = app.users.byUsername("zed-user")!;
      expect(zed).toMatchObject({
        role: "member",
        disabled: false,
        about: "A test teammate.",
      });
      expect(app.projects.personal(zed.id)?.name).toBe("personal");
      const projectId = app.projects.teamProjectIds()[0]!;
      expect(app.projects.byId(projectId)?.name).toBe("nebula");
      expect(app.projects.isMember(projectId, zed.id)).toBeTrue();
      expect(app.providers.list()[0]).toMatchObject({
        name: "mock-provider",
        baseUrl: MODEL_URL,
      });
      const skill = app.skills.list()[0]!;
      expect(skill).toMatchObject({
        name: "paper-skill",
        body: "Check the sources.\n",
      });
      const server = app.mcp.list()[0]!;
      expect(server.tools.map((tool) => tool.name)).toEqual(["read_note"]);
      expect(app.agents.byName("guide")).toMatchObject({
        providerId: app.providers.list()[0]!.id,
        model: { id: "fake-model", tools: true },
        skills: [skill.id],
        servers: [{ serverId: server.id, read: true, write: false }],
      });
      expect(fake.calls).toContain(`${MODEL_URL}/models`);
      expect(fake.calls).toContain(SKILL_URL);
      expect(fake.calls).toContain(MCP_URL);
      expect(loginCount(app.db)).toBe(0);
      expect(lines.join("\n")).not.toContain("test-password");
      expect(lines.join("\n")).not.toContain("hunter2-test");
      const client = app.client();
      expect((await client.login("admin", "hunter2-test")).status).toBe(200);
      const tools = await client.call("GET", "/api/tools");
      expect((await tools.json()).search.provider).toBe("exa");
      await client.call("POST", "/api/logout");
    } finally {
      await app.shutdown();
    }
  });

  test("reapply reports every document unchanged without object writes or fetches", async () => {
    const { app, fake } = await instance();
    try {
      const docs = await fullDocuments();
      await app.provision.apply(docs, ignore);
      const before = snapshot(app.db);
      const writes = mutations(app.db);
      const requests = fake.calls.length;
      const lines: string[] = [];
      expect(
        await app.provision.apply(docs, (line) => lines.push(line)),
      ).toEqual({
        created: 0,
        updated: 0,
        unchanged: docs.length,
      });
      expect(
        lines.slice(0, -1).every((line) => line.startsWith("unchanged ")),
      ).toBeTrue();
      expect(lines).not.toContain(
        "bootstrapped user/admin from user-admin.key",
      );
      expect(writes()).toEqual([]);
      const after = snapshot(app.db);
      delete after.provision_writes;
      expect(after).toEqual(before);
      expect(fake.calls).toHaveLength(requests);
      expect(loginCount(app.db)).toBe(0);
    } finally {
      await app.shutdown();
    }
  });

  test("changes a model through its catalog and preserves omitted agent fields", async () => {
    const { app } = await instance();
    try {
      await app.provision.apply(await fullDocuments(), ignore);
      const before = app.agents.byName("guide")!;
      expect(
        await app.provision.apply(
          documents(object("Agent", "guide", { model: "fake-model-next" })),
          ignore,
        ),
      ).toEqual({ created: 0, updated: 1, unchanged: 0 });
      const after = app.agents.byName("guide")!;
      expect(after).toEqual({
        ...before,
        model: {
          ...before.model,
          id: "fake-model-next",
          name: "Fake model 2",
          contextLength: 65_536,
        },
      });
    } finally {
      await app.shutdown();
    }
  });

  test.each([
    ["baseUrl", "http://other-models.test/v1"],
    ["wire", "openrouter"],
    ["keyFrom", "provider-alternate"],
  ])(
    "refuses immutable provider %s with source and identity",
    async (field, value) => {
      const { app, fake } = await instance();
      try {
        await app.provision.apply(documents(provider()), ignore);
        const before = snapshot(app.db);
        const requests = fake.calls.length;
        await expect(
          app.provision.apply(
            documents(object("Provider", "mock-provider", { [field]: value })),
            ignore,
          ),
        ).rejects.toThrow(
          new RegExp(`instance.yaml: Provider/mock-provider:.*spec\\.${field}`),
        );
        expect(snapshot(app.db)).toEqual(before);
        expect(fake.calls).toHaveLength(requests);
        expect(loginCount(app.db)).toBe(0);
      } finally {
        await app.shutdown();
      }
    },
  );

  test("diffs project membership, preserves omissions and never prunes unnamed rows", async () => {
    const { app } = await instance();
    try {
      await app.provision.apply(
        documents(
          user(),
          object("Project", "nebula", { members: ["admin", "zed-user"] }),
        ),
        ignore,
      );
      const id = app.projects.teamProjectIds()[0]!;
      const adminId = app.users.byUsername("admin")!.id;
      const zedId = app.users.byUsername("zed-user")!.id;
      const wanted = documents(
        object("Project", "nebula", { members: ["zed-user"] }),
      );
      expect((await app.provision.apply(wanted, ignore)).updated).toBe(1);
      expect(app.projects.memberIds(id)).toEqual([zedId]);
      expect(app.projects.isMember(id, adminId)).toBeFalse();
      const writes = mutations(app.db);
      expect((await app.provision.apply(wanted, ignore)).unchanged).toBe(1);
      expect(writes()).toEqual([]);
      await app.provision.apply(
        documents(
          object("Project", "nebula", {
            description: "A changed description",
          }),
        ),
        ignore,
      );
      expect(app.projects.memberIds(id)).toEqual([zedId]);
      expect(app.users.byId(zedId)).not.toBeNull();
      expect(app.projects.personal(zedId)).not.toBeNull();
    } finally {
      await app.shutdown();
    }
  });

  test("clears explicit agent lists while leaving their referenced objects", async () => {
    const { app } = await instance();
    try {
      await app.provision.apply(await fullDocuments(), ignore);
      await app.provision.apply(
        documents(
          object("Agent", "guide", {
            skills: [],
            servers: [],
          }),
        ),
        ignore,
      );
      expect(app.agents.byName("guide")).toMatchObject({
        skills: [],
        servers: [],
      });
      expect(app.skills.list()).toHaveLength(1);
      expect(app.mcp.list()).toHaveLength(1);
    } finally {
      await app.shutdown();
    }
  });

  test.each([true, false])(
    "never resets an existing password or its initial mustChangePassword=%s",
    async (mustChangePassword) => {
      const { app, fake } = await instance();
      try {
        await app.provision.apply(
          documents(user({ mustChangePassword })),
          ignore,
        );
        const before = app.users.byUsername("zed-user")!;
        const next = await recompose(app, fake.fetcher, {
          "user-zed": "changed-password",
        });
        try {
          expect(
            await next.provision.apply(
              documents(user({ mustChangePassword: !mustChangePassword })),
              ignore,
            ),
          ).toEqual({ created: 0, updated: 0, unchanged: 1 });
          expect(app.users.byUsername("zed-user")).toEqual(before);
          expect(
            await Bun.password.verify("test-password", before.passwordHash),
          ).toBeTrue();
          expect(
            await Bun.password.verify("changed-password", before.passwordHash),
          ).toBeFalse();
        } finally {
          await next.shutdown();
        }
      } finally {
        await app.shutdown();
      }
    },
  );

  test("new agents get defaults and explicit null restores provider defaults", async () => {
    const { app } = await instance();
    try {
      await app.provision.apply(documents(provider(), agent()), ignore);
      expect(app.agents.byName("guide")).toMatchObject({
        avatar: "bot",
        thinking: null,
        effort: null,
        mcpMode: "auto",
        skills: [],
        servers: [],
      });
      await app.provision.apply(
        documents(
          object("Agent", "guide", {
            thinking: "on",
            effort: "high",
            mcpMode: "catalog",
          }),
        ),
        ignore,
      );
      await app.provision.apply(
        documents(
          object("Agent", "guide", {
            thinking: null,
            effort: null,
          }),
        ),
        ignore,
      );
      expect(app.agents.byName("guide")).toMatchObject({
        thinking: null,
        effort: null,
        mcpMode: "catalog",
      });
    } finally {
      await app.shutdown();
    }
  });

  test.each(["openrouter", "openai-compatible", "gemini"])(
    "uses the %s route's effort rules rather than saving unchecked fields",
    async (wire) => {
      const { app } = await instance();
      try {
        const docs = documents(provider({ wire }), agent({ effort: "xhigh" }));
        expect(() => app.provision.validate(docs)).not.toThrow();
        if (wire === "openrouter") {
          await app.provision.apply(docs, ignore);
          expect(app.agents.byName("guide")?.effort).toBe("xhigh");
        } else {
          await expect(app.provision.apply(docs, ignore)).rejects.toThrow(
            /instance.yaml: Agent\/guide:.*effort/,
          );
          expect(app.agents.list()).toEqual([]);
          expect(app.providers.list()).toHaveLength(1);
        }
      } finally {
        await app.shutdown();
      }
    },
  );

  test("refuses an unlisted model without replacing a saved agent", async () => {
    const { app } = await instance();
    try {
      await app.provision.apply(documents(provider(), agent()), ignore);
      const before = app.agents.byName("guide");
      await expect(
        app.provision.apply(
          documents(object("Agent", "guide", { model: "missing-model" })),
          ignore,
        ),
      ).rejects.toThrow(/instance.yaml: Agent\/guide:.*model/);
      expect(app.agents.byName("guide")).toEqual(before);
      expect(loginCount(app.db)).toBe(0);
    } finally {
      await app.shutdown();
    }
  });

  test.each([
    object("Agent", "guide", { provider: "absent", model: "fake-model" }),
    object("Project", "nebula", { members: ["absent-user"] }),
    provider({ keyFrom: "provider-absent" }),
  ])("offline refusals leave an empty instance untouched: %j", async (bad) => {
    const { app, fake } = await instance();
    try {
      const docs = documents(bad);
      const before = snapshot(app.db);
      const writes = changes(app.db);
      expect(() => app.provision.validate(docs)).toThrow("instance.yaml:");
      await expect(app.provision.apply(docs, ignore)).rejects.toThrow(
        "instance.yaml:",
      );
      expect(snapshot(app.db)).toEqual(before);
      expect(changes(app.db)).toBe(writes);
      expect(app.users.count()).toBe(0);
      expect(fake.calls).toEqual([]);
    } finally {
      await app.shutdown();
    }
  });

  test("a malformed later source never bootstraps an earlier valid document", async () => {
    const { app, fake } = await instance();
    try {
      const before = snapshot(app.db);
      const writes = changes(app.db);
      await expect(
        (async () =>
          app.provision.apply(
            parse([
              { path: "first.yaml", text: JSON.stringify(provider()) },
              {
                path: "bad.yaml",
                text: JSON.stringify(user({ tz: "Not/AZone" })),
              },
            ]),
            ignore,
          ))(),
      ).rejects.toThrow(/bad.yaml: User\/zed-user:.*tz/);
      expect(snapshot(app.db)).toEqual(before);
      expect(changes(app.db)).toBe(writes);
      expect(fake.calls).toEqual([]);
    } finally {
      await app.shutdown();
    }
  });

  test("a raw skill's refused name reports both the assertion and fetched name", async () => {
    const { app, fake } = await instance();
    fake.state.skillName = "actual-skill";
    try {
      await expect(
        app.provision.apply(
          documents(object("Skill", "paper-skill", { url: SKILL_URL })),
          ignore,
        ),
      ).rejects.toThrow(
        /instance.yaml: Skill\/paper-skill:.*paper-skill.*actual-skill/,
      );
      expect(
        app.skills.list().some((skill) => skill.name === "paper-skill"),
      ).toBeFalse();
      expect(loginCount(app.db)).toBe(0);
    } finally {
      await app.shutdown();
    }
  });

  test.each([false, true])(
    "index skills use and verify the discovered digest, mismatch=%s",
    async (badDigest) => {
      const { app, fake } = await instance();
      fake.state.badDigest = badDigest;
      try {
        const docs = documents(
          object("Skill", "paper-skill", {
            url: INDEX_URL,
            fromIndex: true,
          }),
        );
        if (badDigest) {
          await expect(app.provision.apply(docs, ignore)).rejects.toThrow(
            /instance.yaml: Skill\/paper-skill:.*digest/,
          );
          expect(app.skills.list()).toEqual([]);
        } else {
          await app.provision.apply(docs, ignore);
          expect(app.skills.list()[0]).toMatchObject({
            sourceKind: "index",
            sourceUrl: INDEX_URL,
            sourceDigest: fake.digest(),
          });
          const requests = fake.calls.length;
          expect((await app.provision.apply(docs, ignore)).unchanged).toBe(1);
          expect(fake.calls).toHaveLength(requests);
        }
        expect(fake.calls).toContain(
          `${INDEX_URL}/.well-known/agent-skills/index.json`,
        );
        expect(fake.calls).toContain(SKILL_URL);
      } finally {
        await app.shutdown();
      }
    },
  );

  test("MCP endpoint discovery and settings use separate guarded updates", async () => {
    const { app, fake } = await instance();
    try {
      await app.provision.apply(
        documents(
          object("McpServer", "toolbox", {
            url: MCP_URL,
            readPatterns: ["read_*"],
            writePatterns: [],
          }),
        ),
        ignore,
      );
      const before = app.mcp.list()[0]!;
      expect(before).toMatchObject({
        read: true,
        write: false,
        instructionsOn: true,
      });
      const docs = documents(
        object("McpServer", "toolbox", {
          url: "https://mcp.test/next",
          instructionsOn: false,
          timeoutMs: 12_000,
        }),
      );
      fake.state.mcpFailure = true;
      await expect(app.provision.apply(docs, ignore)).rejects.toThrow(
        /instance.yaml: McpServer\/toolbox:/,
      );
      expect(app.mcp.list()[0]).toEqual(before);
      expect(loginCount(app.db)).toBe(0);
      fake.state.mcpFailure = false;
      expect((await app.provision.apply(docs, ignore)).updated).toBe(1);
      expect(app.mcp.list()[0]).toMatchObject({
        id: before.id,
        url: "https://mcp.test/next",
        instructionsOn: false,
        timeoutMs: 12_000,
        readPatterns: ["read_*"],
        writePatterns: [],
      });
      const requests = fake.calls.length;
      expect((await app.provision.apply(docs, ignore)).unchanged).toBe(1);
      expect(fake.calls).toHaveLength(requests);
    } finally {
      await app.shutdown();
    }
  });

  test("a refused object stops later writes and keeps earlier successful objects", async () => {
    const { app } = await instance();
    try {
      const lines: string[] = [];
      await expect(
        app.provision.apply(
          documents(
            object("Tool", "webfetch", { enabled: false }),
            agent({ model: "missing-model" }),
            user(),
            provider(),
            object("Project", "nebula", { members: ["zed-user"] }),
          ),
          (line) => lines.push(line),
        ),
      ).rejects.toThrow(/Agent\/guide:.*model/);
      expect(lines).toEqual([
        "bootstrapped user/admin from user-admin.key",
        "created user/zed-user",
        "created project/nebula",
        "created provider/mock-provider",
      ]);
      expect(app.users.byUsername("zed-user")).not.toBeNull();
      expect(app.projects.teamProjectIds()).toHaveLength(1);
      expect(app.providers.list()).toHaveLength(1);
      expect(app.agents.list()).toEqual([]);
      const client = app.client();
      expect((await client.login("admin", "hunter2-test")).status).toBe(200);
      const response = await client.call("GET", "/api/tools");
      expect(
        (await response.json()).web.find(
          (tool: { name: string }) => tool.name === "webfetch",
        ).enabled,
      ).toBeTrue();
    } finally {
      await app.shutdown();
    }
  });

  test.each([{ role: "member" }, { role: "admin", disabled: true }])(
    "the router refuses to demote or disable the provisioning admin: %j",
    async (spec) => {
      const { app } = await instance();
      try {
        await expect(
          app.provision.apply(documents(object("User", "admin", spec)), ignore),
        ).rejects.toThrow(/instance.yaml: User\/admin:/);
        expect(app.users.byUsername("admin")).toMatchObject({
          role: "admin",
          disabled: false,
        });
        expect(loginCount(app.db)).toBe(0);
      } finally {
        await app.shutdown();
      }
    },
  );

  test("normalizes email, prompt, provider slash and visual hosts before comparing", async () => {
    const { app } = await instance();
    try {
      const docs = documents(
        user({ email: "ZED@EXAMPLE.TEST" }),
        provider({ baseUrl: `${MODEL_URL}/` }),
        agent({ prompt: "  Answer plainly. \n" }),
        object("Tool", "visualize", {
          hosts: [
            "https://z-cdn.test/",
            "https://a-cdn.test",
            "https://z-cdn.test",
          ],
        }),
      );
      await app.provision.apply(docs, ignore);
      const writes = mutations(app.db);
      expect(await app.provision.apply(docs, ignore)).toEqual({
        created: 0,
        updated: 0,
        unchanged: docs.length,
      });
      expect(writes()).toEqual([]);
      expect(app.users.byUsername("zed-user")?.email).toBe("zed@example.test");
      expect(app.providers.list()[0]?.baseUrl).toBe(MODEL_URL);
      expect(app.agents.byName("guide")?.prompt).toBe("Answer plainly.");
    } finally {
      await app.shutdown();
    }
  });

  test("inactive composition and apply never repair sessions or fire due automations", async () => {
    const { app, fake } = await instance();
    try {
      await app.provision.apply(documents(provider(), agent()), ignore);
      const admin = app.users.byUsername("admin")!;
      const project = app.projects.personal(admin.id)!;
      const guide = app.agents.byName("guide")!;
      const running = app.sessions.create({
        ownerId: admin.id,
        projectId: project.id,
        agentId: guide.id,
        title: "Interrupted chat",
        now: app.now.value,
        status: "running",
      });
      const client = app.client();
      expect((await client.login("admin", "hunter2-test")).status).toBe(200);
      const response = await client.call(
        "POST",
        `/api/projects/${project.id}/automations`,
        {
          body: {
            name: "due-task",
            agentId: guide.id,
            instructions: "Do not start.",
            schedule: "0 * * * *",
            tz: "UTC",
            deadlineMs: null,
            retentionDays: 30,
            ownMemory: false,
            projectMemory: false,
          },
        },
      );
      expect(response.status).toBe(201);
      const { automation } = await response.json();
      await client.call("POST", "/api/logout");
      app.db
        .query("update automations set next_at = ? where id = ?")
        .run(app.now.value - 1, automation.id);
      const before = snapshot(app.db);
      const requests = fake.calls.length;
      const inactive = await recompose(app, fake.fetcher);
      try {
        expect(snapshot(app.db)).toEqual(before);
        const writes = mutations(app.db);
        await inactive.provision.apply(documents(provider()), ignore);
        await Bun.sleep(0);
        expect(writes()).toEqual([]);
        expect(inactive.sessions.byId(running.id)?.status).toBe("running");
        expect(inactive.automations.byId(automation.id)).toMatchObject({
          nextAt: app.now.value - 1,
          lastRunSessionId: null,
        });
        expect(inactive.runner.registry.size).toBe(0);
        expect(fake.calls).toHaveLength(requests);
      } finally {
        await inactive.shutdown();
      }
    } finally {
      await app.shutdown();
    }
  });
});
