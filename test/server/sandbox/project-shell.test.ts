// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's own shell backend: null follows the instance's, a value
// overrides it, openshell without a gateway is the builtin. A command and
// the offer read the same answer, every project shares the one gateway
// manager, and a project's change drains nothing.

import { describe, expect, test } from "bun:test";
import type { ShellBackend } from "../../../src/server/bash/index.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { toolsArea } from "../../../src/server/tools/index.ts";
import type {
  ProjectResponse,
  ProjectsResponse,
} from "../../../src/shared/api/projects.ts";
import type { SandboxResponse } from "../../../src/shared/api/sandbox.ts";
import type { ProjectDetail } from "../../../src/shared/contracts/project.ts";
import { hashPassword, type TestApp, testApp } from "../../helpers/app.ts";
import { memoryDb } from "../../helpers/db.ts";
import { createTeam } from "../../helpers/projects.ts";
import { fakeGateway } from "../../helpers/sandbox.ts";
import { callCaps, run as runCommand, setup } from "../bash/helpers.ts";

const KEYS = {
  "openshell-gateway-ca": "ca-pem-value",
  "openshell-gateway-cert": "cert-pem-value",
  "openshell-gateway-key": "key-pem-value",
};
const ENDPOINT = "https://gateway.test:17670";
const builtin: ShellBackend = { run: async () => ({}) as never };

type Admin = ReturnType<TestApp["client"]>;

async function run(
  body: (app: TestApp, admin: Admin) => Promise<void>,
  secrets: Record<string, string> = KEYS,
  fake = fakeGateway(),
) {
  const app = await testApp({ secrets, sandboxGateway: fake.connect });
  try {
    const admin = app.client();
    await admin.login("admin", "hunter2-test");
    await body(app, admin);
  } finally {
    await app.shutdown();
    app.db.close();
  }
}

async function setBackend(
  admin: Admin,
  project: ProjectDetail,
  backend: string | null,
): Promise<ProjectDetail> {
  const res = await admin.call("PATCH", `/api/projects/${project.id}`, {
    body: { backend },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as ProjectResponse).project;
}

async function instance(admin: Admin, body: Record<string, unknown>) {
  const res = await admin.call("PUT", "/api/admin/sandbox", { body });
  expect(res.status).toBe(200);
  return (await res.json()) as SandboxResponse;
}

// the offer of a main round in the project, over the app's own bash
function offeredSandbox(app: TestApp, projectId: string): boolean {
  const tools = toolsArea({
    db: memoryDb(),
    fetcher: (async () => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch,
    secret: () => null,
    clock: () => app.now.value,
    log: silent,
    render: (md) => md,
    skills: { forAgent: () => [], body: () => null, file: () => null },
    bash: app.bash,
  });
  const offered = tools.offered(app.now.value, "", false, "auto", {
    projectId,
    automation: null,
    phase: "main",
  });
  return offered.sandbox === true;
}

const shellOf = (app: TestApp, projectId: string) =>
  app.sandbox.shell(builtin, projectId) === builtin ? "builtin" : "openshell";

describe("a project's shell", () => {
  test("null follows the instance both ways, and each value overrides it", async () => {
    await run(async (app, admin) => {
      const ops = await createTeam(admin, "ops");
      expect(ops.backend).toBeNull();
      expect(ops.instanceBackend).toBe("builtin");
      await instance(admin, { endpoint: ENDPOINT });
      expect(shellOf(app, ops.id)).toBe("builtin");
      await setBackend(admin, ops, "openshell");
      expect(shellOf(app, ops.id)).toBe("openshell");
      await setBackend(admin, ops, null);
      await instance(admin, { backend: "openshell" });
      expect(shellOf(app, ops.id)).toBe("openshell");
      const pinned = await setBackend(admin, ops, "builtin");
      expect(pinned).toMatchObject({
        backend: "builtin",
        instanceBackend: "openshell",
      });
      expect(shellOf(app, ops.id)).toBe("builtin");
      // without a project, the instance's
      expect(app.sandbox.shell(builtin)).not.toBe(builtin);
    });
  });

  test("openshell without a gateway is the builtin", async () => {
    await run(async (app, admin) => {
      const ops = await createTeam(admin, "ops");
      await setBackend(admin, ops, "openshell");
      expect(shellOf(app, ops.id)).toBe("builtin");
      expect(app.bash.sandbox?.(ops.id)).toBeNull();
      expect(offeredSandbox(app, ops.id)).toBe(false);
    }, {});
  });

  test("a command and the offer agree, and two projects on one instance run different shells", async () => {
    const fake = fakeGateway();
    await run(
      async (app, admin) => {
        const box = await createTeam(admin, "box");
        const plain = await createTeam(admin, "plain");
        await instance(admin, { endpoint: ENDPOINT });
        await setBackend(admin, box, "openshell");
        expect(shellOf(app, box.id)).toBe("openshell");
        expect(shellOf(app, plain.id)).toBe("builtin");
        expect(app.bash.sandbox?.(box.id)).toEqual(app.sandbox.net());
        expect(app.bash.sandbox?.(plain.id)).toBeNull();
        expect(offeredSandbox(app, box.id)).toBe(true);
        expect(offeredSandbox(app, plain.id)).toBe(false);
        // the instance's own switch keeps the one manager every project
        // shares
        const leases = app.sandbox.leases();
        expect(leases).not.toBeNull();
        await instance(admin, { backend: "openshell" });
        expect(app.sandbox.leases()).toBe(leases);
        expect(shellOf(app, plain.id)).toBe("openshell");
        expect(fake.configs).toHaveLength(1);
      },
      KEYS,
      fake,
    );
  });

  test("a project's change drains nothing", async () => {
    const fake = fakeGateway();
    await run(
      async (app, admin) => {
        const box = await createTeam(admin, "box");
        await instance(admin, { endpoint: ENDPOINT });
        await setBackend(admin, box, "openshell");
        expect(shellOf(app, box.id)).toBe("openshell");
        const leases = app.sandbox.leases()!;
        const hold = await leases.acquire(
          {
            projectId: box.id,
            workspace: { id: "chat", sessionId: "chat" },
            root: "chat",
            sendId: "send",
            subagent: false,
            repos: [],
            repoFileBytes: 0,
            network: false,
            credentials: [],
          },
          app.now.value + 20_000,
          new AbortController().signal,
        );
        if (hold === "busy") throw new Error("busy");
        await setBackend(admin, box, "builtin");
        expect(shellOf(app, box.id)).toBe("builtin");
        expect(app.sandbox.leases()).toBe(leases);
        hold.release();
        expect(fake.deletes).toEqual([]);
        expect(leases.rows()).toHaveLength(1);
      },
      KEYS,
      fake,
    );
  });

  test("the Sandbox page counts the projects that override", async () => {
    await run(async (_app, admin) => {
      const a = await createTeam(admin, "a-team");
      const b = await createTeam(admin, "b-team");
      await createTeam(admin, "c-team");
      await setBackend(admin, a, "openshell");
      await setBackend(admin, b, "builtin");
      const res = await admin.call("GET", "/api/admin/sandbox");
      expect(((await res.json()) as SandboxResponse).overrides).toEqual({
        builtin: 1,
        openshell: 1,
      });
    });
  });

  test("a bash command asks the shell of its own project", async () => {
    const asked: (string | null)[] = [];
    const s = setup({}, undefined, undefined, (shell, projectId) => {
      asked.push(projectId);
      return shell;
    });
    try {
      const result = await runCommand(s, "echo hi", callCaps);
      expect(result.error).toBe(false);
      expect(asked).toEqual([s.projectId]);
    } finally {
      s.db.close();
    }
  });
});

describe("who sets a project's shell", () => {
  test("the PATCH takes builtin, openshell or null and refuses any other word", async () => {
    await run(async (_app, admin) => {
      const ops = await createTeam(admin, "ops");
      for (const backend of ["docker", "", "Builtin", 1, true, ["builtin"]]) {
        const res = await admin.call("PATCH", `/api/projects/${ops.id}`, {
          body: { backend },
        });
        expect(res.status, JSON.stringify(backend)).toBe(400);
        expect(await res.text()).toContain(
          "backend must be builtin, openshell or null",
        );
      }
      // a backend alone keeps the name and description
      const set = await setBackend(admin, ops, "openshell");
      expect(set).toMatchObject({
        name: "ops",
        description: "A team project.",
        backend: "openshell",
      });
      expect((await setBackend(admin, ops, null)).backend).toBeNull();
    });
  });

  test("a member reads a team project's shell, and only its owner sets a personal one", async () => {
    await run(async (app, admin) => {
      const user = app.createUser({
        username: "casey",
        fullName: "Casey",
        email: "casey@example.com",
        role: "member",
        passwordHash: await hashPassword("pw"),
        mustChangePassword: false,
        now: app.now.value,
      });
      const member = app.client();
      await member.login("casey", "pw");
      const ops = await createTeam(admin, "ops", [user.id]);
      await setBackend(admin, ops, "openshell");
      let res = await member.call("PATCH", `/api/projects/${ops.id}`, {
        body: { backend: "builtin" },
      });
      expect(res.status).toBe(403);
      res = await member.call("GET", `/api/projects/${ops.id}`);
      expect(((await res.json()) as ProjectResponse).project).toMatchObject({
        backend: "openshell",
        instanceBackend: "builtin",
      });
      // a personal project is not the admin's to set through the team route
      const own = (
        (await (
          await member.call("GET", "/api/projects")
        ).json()) as ProjectsResponse
      ).projects.find((p) => p.kind === "personal")!;
      res = await admin.call("PATCH", `/api/projects/${own.id}`, {
        body: { backend: "openshell" },
      });
      expect(res.status).toBe(404);
      res = await member.call("PATCH", "/api/profile/project", {
        body: { backend: "openshell" },
      });
      expect(res.status).toBe(200);
      const project = ((await res.json()) as ProjectResponse).project;
      expect(project).toMatchObject({ id: own.id, backend: "openshell" });
      expect(app.projects.backendOf(own.id)).toBe("openshell");
      for (const body of [{}, { backend: "docker" }, { other: 1 }]) {
        res = await member.call("PATCH", "/api/profile/project", { body });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });
  });
});
