// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's own image variant: null follows the instance's, a value
// overrides it, a custom image beats both. Each lease is made from its
// project's image, a project's change retires only its own chats'
// sandboxes, and the warm pool holds the instance's image alone.

import { describe, expect, test } from "bun:test";
import type { ShellCall } from "../../../src/server/bash/index.ts";
import {
  makeBashTool,
  offeredShell,
} from "../../../src/server/tools/builtin/bash.ts";
import type { ProjectResponse } from "../../../src/shared/api/projects.ts";
import type { ProjectDetail } from "../../../src/shared/contracts/project.ts";
import { type TestApp, testApp } from "../../helpers/app.ts";
import { createTeam } from "../../helpers/projects.ts";
import { fakeGateway, until } from "../../helpers/sandbox.ts";

const KEYS = {
  "openshell-gateway-ca": "ca-pem-value",
  "openshell-gateway-cert": "cert-pem-value",
  "openshell-gateway-key": "key-pem-value",
};
const ENDPOINT = "https://gateway.test:17670";
const IMAGE = (variant: string) =>
  `ghcr.io/stefanprodan/1ctx-shell:dev-${variant}`;

type Admin = ReturnType<TestApp["client"]>;

async function run(
  body: (app: TestApp, admin: Admin) => Promise<void>,
  fake = fakeGateway(),
) {
  const app = await testApp({ secrets: KEYS, sandboxGateway: fake.connect });
  try {
    const admin = app.client();
    await admin.login("admin", "hunter2-test");
    await body(app, admin);
  } finally {
    await app.shutdown();
    app.db.close();
  }
}

async function setVariant(
  admin: Admin,
  project: ProjectDetail,
  variant: unknown,
): Promise<ProjectDetail> {
  const res = await admin.call("PATCH", `/api/projects/${project.id}`, {
    body: { variant },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as ProjectResponse).project;
}

async function instance(admin: Admin, body: Record<string, unknown>) {
  const res = await admin.call("PUT", "/api/admin/sandbox", { body });
  expect(res.status).toBe(200);
}

const call = (projectId: string, chat: string, send = "send"): ShellCall => ({
  projectId,
  workspace: { id: chat, sessionId: chat },
  root: chat,
  sendId: send,
  subagent: false,
  repos: [],
  repoFileBytes: 0,
  network: false,
  credentials: [],
});

// a sandbox a chat of the project used and let go, idle
async function used(app: TestApp, projectId: string, chat: string) {
  const hold = await app.sandbox
    .leases()!
    .acquire(
      call(projectId, chat),
      app.now.value + 20_000,
      new AbortController().signal,
    );
  if (hold === "busy") throw new Error("busy");
  hold.release();
  return hold.sandbox;
}

const imageOf = (fake: ReturnType<typeof fakeGateway>, sandbox: string) =>
  fake.creates.find((spec) => spec.name === sandbox)?.image;

describe("a project's variant", () => {
  test("null follows the instance, a value overrides it, a custom image beats both", async () => {
    await run(async (app, admin) => {
      const ops = await createTeam(admin, "ops");
      expect(ops).toMatchObject({ variant: null, instanceVariant: "python" });
      expect(app.sandbox.variant(ops.id)).toBe("python");
      await instance(admin, { variant: "bun" });
      expect(app.sandbox.variant(ops.id)).toBe("bun");
      const set = await setVariant(admin, ops, "go");
      expect(set).toMatchObject({ variant: "go", instanceVariant: "bun" });
      expect(app.sandbox.variant(ops.id)).toBe("go");
      // without a project, the instance's
      expect(app.sandbox.variant()).toBe("bun");
      await instance(admin, { image: "registry.test/shell:1" });
      expect(app.sandbox.variant(ops.id)).toBeNull();
      const read = await admin.call("GET", `/api/projects/${ops.id}`);
      expect(((await read.json()) as ProjectResponse).project).toMatchObject({
        variant: "go",
        instanceVariant: null,
      });
      await instance(admin, { image: null });
      expect((await setVariant(admin, ops, null)).variant).toBeNull();
      expect(app.sandbox.variant(ops.id)).toBe("bun");
    });
  });

  test("the offer's description names the project's own variant", async () => {
    await run(async (app, admin) => {
      const ops = await createTeam(admin, "ops");
      const plain = await createTeam(admin, "plain");
      await instance(admin, { backend: "openshell", endpoint: ENDPOINT });
      await setVariant(admin, ops, "rust");
      const words = (projectId: string) =>
        makeBashTool({
          bash: app.bash,
          ...offeredShell(app.bash, { sandbox: true }, projectId),
        }).description;
      expect(words(ops.id)).toContain("Rust 1.");
      expect(words(plain.id)).not.toContain("Rust 1.");
      expect(words(plain.id)).toContain("Python 3.15 with uv, git");
    });
  });

  test("the PATCH takes the four words or null and refuses any other", async () => {
    await run(async (_app, admin) => {
      const ops = await createTeam(admin, "ops");
      for (const variant of ["node", "", "Python", 1, true, ["go"]]) {
        const res = await admin.call("PATCH", `/api/projects/${ops.id}`, {
          body: { variant },
        });
        expect(res.status, JSON.stringify(variant)).toBe(400);
        expect(await res.text()).toContain(
          "variant must be one of python, bun, go, rust or null",
        );
      }
      // a variant alone keeps the rest
      expect(await setVariant(admin, ops, "bun")).toMatchObject({
        name: "ops",
        description: "A team project.",
        backend: null,
        variant: "bun",
      });
    });
  });

  test("an admin sets a personal project's variant, and the answer names its shell alone", async () => {
    await run(async (app, admin) => {
      const user = app.createUser({
        username: "casey",
        fullName: "Casey",
        email: "casey@example.com",
        role: "member",
        passwordHash: "x",
        mustChangePassword: false,
        now: app.now.value,
      });
      const own = app.projects.personal(user.id)!;
      const res = await admin.call("PATCH", `/api/projects/${own.id}`, {
        body: { variant: "go", backend: "openshell" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: own.id,
        backend: "openshell",
        variant: "go",
      });
      expect(app.projects.variantOf(own.id)).toBe("go");
    });
  });
});

describe("a lease's image", () => {
  test("two projects on one instance get sandboxes of their own images", async () => {
    const fake = fakeGateway();
    await run(async (app, admin) => {
      const go = await createTeam(admin, "go-team");
      const plain = await createTeam(admin, "plain");
      await instance(admin, { backend: "openshell", endpoint: ENDPOINT });
      await setVariant(admin, go, "go");
      const a = await used(app, go.id, "chat-a");
      const b = await used(app, plain.id, "chat-b");
      expect(imageOf(fake, a)).toBe(IMAGE("go"));
      expect(imageOf(fake, b)).toBe(IMAGE("python"));
      // one manager serves both, and each image's roots are checked once
      expect(fake.configs).toHaveLength(1);
      expect(fake.rootChecks).toEqual([a, b]);
      await used(app, go.id, "chat-c");
      expect(fake.rootChecks).toHaveLength(2);
    }, fake);
  });

  test("a project's change retires only its own chats' sandboxes", async () => {
    const fake = fakeGateway();
    await run(async (app, admin) => {
      const ops = await createTeam(admin, "ops");
      const plain = await createTeam(admin, "plain");
      await instance(admin, { backend: "openshell", endpoint: ENDPOINT });
      const leases = app.sandbox.leases()!;
      const mine = await used(app, ops.id, "chat-a");
      const theirs = await used(app, plain.id, "chat-b");
      // a chat's command still holds its sandbox through the change
      const held = await leases.acquire(
        call(ops.id, "chat-a"),
        app.now.value + 20_000,
        new AbortController().signal,
      );
      if (held === "busy") throw new Error("busy");
      expect(held.sandbox).toBe(mine);
      await setVariant(admin, ops, "bun");
      expect(app.sandbox.leases()).toBe(leases);
      expect(fake.deletes).toEqual([]);
      const next = leases.acquire(
        call(ops.id, "chat-a", "send2"),
        app.now.value + 20_000,
        new AbortController().signal,
      );
      held.release();
      const hold = await next;
      if (hold === "busy") throw new Error("busy");
      hold.release();
      expect(hold.sandbox).not.toBe(mine);
      expect(imageOf(fake, hold.sandbox)).toBe(IMAGE("bun"));
      await until(() => fake.deletes.includes(mine));
      // the other project's sandbox stays, and its chat comes back to it
      expect(fake.deletes).not.toContain(theirs);
      expect(await used(app, plain.id, "chat-b")).toBe(theirs);
    }, fake);
  });

  test("the warm pool holds the instance's image, and another project's is made cold", async () => {
    const fake = fakeGateway();
    await run(async (app, admin) => {
      const go = await createTeam(admin, "go-team");
      const plain = await createTeam(admin, "plain");
      const res = await admin.call("PUT", "/api/limits", {
        body: { values: { sandboxWarm: 1 } },
      });
      expect(res.status).toBe(200);
      await instance(admin, { backend: "openshell", endpoint: ENDPOINT });
      await setVariant(admin, go, "go");
      const leases = app.sandbox.leases()!;
      const warm = () => leases.rows().filter((row) => row.state === "warm");
      await until(() => warm().length === 1);
      const spare = warm()[0]!.sandbox;
      expect(imageOf(fake, spare)).toBe(IMAGE("python"));
      const cold = await used(app, go.id, "chat-a");
      expect(cold).not.toBe(spare);
      expect(imageOf(fake, cold)).toBe(IMAGE("go"));
      expect(warm().map((row) => row.sandbox)).toEqual([spare]);
      // a project on the instance's image takes the warm one
      expect(await used(app, plain.id, "chat-b")).toBe(spare);
    }, fake);
  });
});
