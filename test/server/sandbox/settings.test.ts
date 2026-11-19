// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandbox shell's settings: one row with its instance id, an https
// endpoint, the key files by presence alone, and the shell bash gets.

import { describe, expect, test } from "bun:test";
import { publish } from "../../../src/server/lib/bus.ts";
import {
  defaultImage,
  INSTANCE_LABEL,
} from "../../../src/server/sandbox/index.ts";
import type { SandboxResponse } from "../../../src/shared/api/sandbox.ts";
import { type TestApp, testApp } from "../../helpers/app.ts";
import { fakeGateway, until } from "../../helpers/sandbox.ts";

const KEYS = {
  "openshell-gateway-ca": "ca-pem-value",
  "openshell-gateway-cert": "cert-pem-value",
  "openshell-gateway-key": "key-pem-value",
};
const ENDPOINT = "https://gateway.test:17670";

async function run(
  body: (app: TestApp, admin: ReturnType<TestApp["client"]>) => Promise<void>,
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

describe("sandbox settings", () => {
  test("start builtin, with an instance id made once", async () => {
    await run(async (app, admin) => {
      const res = await admin.call("GET", "/api/admin/sandbox");
      expect(res.status).toBe(200);
      const body = (await res.json()) as SandboxResponse;
      expect(body.settings).toMatchObject({
        shell: "builtin",
        endpoint: null,
        image: null,
      });
      expect(body.settings.instanceId).toMatch(/^[0-9a-z]{12}$/);
      expect(body.gatewayLabel).toBe(`1ctx-${body.settings.instanceId}`);
      expect(body.defaultImage).toBe("ghcr.io/stefanprodan/1ctx-shell:dev");
      expect(body.keys).toEqual({ ca: true, cert: true, key: true });
      expect(body.active).toBe(false);
      expect(app.sandbox.store.settings().instanceId).toBe(
        body.settings.instanceId,
      );
      // names presence alone, never a value
      expect(JSON.stringify(body)).not.toContain("pem-value");
    });
  });

  test("an endpoint is an https origin and nothing else", async () => {
    await run(async (_app, admin) => {
      for (const endpoint of [
        "http://gateway.test:17670",
        "https://gateway.test:17670/v1",
        "https://user:pass@gateway.test",
        "https://gateway.test?x=1",
        "gateway.test:17670",
      ]) {
        const res = await admin.call("PUT", "/api/admin/sandbox", {
          body: { endpoint },
        });
        expect(res.status).toBe(400);
      }
      for (const body of [{}, { other: 1 }, { shell: "docker" }]) {
        const res = await admin.call("PUT", "/api/admin/sandbox", { body });
        expect(res.status).toBe(400);
      }
      const res = await admin.call("PUT", "/api/admin/sandbox", {
        body: { endpoint: ENDPOINT, image: "registry.test/sbx:1" },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as SandboxResponse).settings).toMatchObject({
        shell: "builtin",
        endpoint: ENDPOINT,
        image: "registry.test/sbx:1",
      });
    });
  });

  test("the sandbox shell needs an endpoint and every key file", async () => {
    await run(
      async (_app, admin) => {
        let res = await admin.call("PUT", "/api/admin/sandbox", {
          body: { shell: "sandbox" },
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("needs a gateway endpoint");
        res = await admin.call("PUT", "/api/admin/sandbox", {
          body: { shell: "sandbox", endpoint: ENDPOINT },
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("openshell-gateway-key.key");
      },
      { "openshell-gateway-ca": "ca", "openshell-gateway-cert": "cert" },
    );
  });

  test("bash runs builtin until the sandbox shell is on, then on the gateway the settings name", async () => {
    const fake = fakeGateway();
    await run(
      async (app, admin) => {
        const builtin = { run: async () => ({}) as never };
        expect(app.sandbox.shell(builtin)).toBe(builtin);
        const res = await admin.call("PUT", "/api/admin/sandbox", {
          body: { shell: "sandbox", endpoint: ENDPOINT },
        });
        expect(((await res.json()) as SandboxResponse).active).toBe(true);
        expect(app.sandbox.shell(builtin)).not.toBe(builtin);
        expect(fake.configs).toEqual([
          {
            endpoint: ENDPOINT,
            ca: "ca-pem-value",
            cert: "cert-pem-value",
            key: "key-pem-value",
          },
        ]);
        await admin.call("PUT", "/api/admin/sandbox", {
          body: { shell: "builtin" },
        });
        expect(app.sandbox.shell(builtin)).toBe(builtin);
        expect(app.sandbox.leases()).toBeNull();
      },
      KEYS,
      fake,
    );
  });

  test("the area recycles a session's sandboxes on its bus events", async () => {
    const fake = fakeGateway();
    await run(
      async (app, admin) => {
        await admin.call("PUT", "/api/admin/sandbox", {
          body: { shell: "sandbox", endpoint: ENDPOINT },
        });
        const leases = app.sandbox.leases()!;
        const hold = await leases.acquire(
          {
            projectId: "project",
            workspace: { id: "chat-gone", sessionId: "chat-gone" },
            sendId: "send",
            subagent: false,
            repos: [],
            repoFileBytes: 0,
            web: null,
            credentials: [],
          },
          app.now.value + 20_000,
          new AbortController().signal,
        );
        if (hold === "busy") throw new Error("busy");
        expect(fake.sandboxes.get(hold.sandbox)?.labels).toEqual({
          [INSTANCE_LABEL]: app.sandbox.store.settings().instanceId,
        });
        hold.release();
        publish({
          type: "session.deleted",
          data: { projectId: "project", sessionId: "chat-gone" },
        });
        await until(() => leases.rows().length === 0);
        expect(fake.deletes).toEqual([hold.sandbox]);
      },
      KEYS,
      fake,
    );
  });

  test("a new image leaves the old manager's held sandbox to its command", async () => {
    const fake = fakeGateway();
    await run(
      async (app, admin) => {
        await admin.call("PUT", "/api/admin/sandbox", {
          body: { shell: "sandbox", endpoint: ENDPOINT },
        });
        const old = app.sandbox.leases()!;
        const hold = await old.acquire(
          {
            projectId: "project",
            workspace: { id: "chat", sessionId: "chat" },
            sendId: "send",
            subagent: false,
            repos: [],
            repoFileBytes: 0,
            web: null,
            credentials: [],
          },
          app.now.value + 20_000,
          new AbortController().signal,
        );
        if (hold === "busy") throw new Error("busy");
        await admin.call("PUT", "/api/admin/sandbox", {
          body: { image: "registry.test/sbx:2" },
        });
        const next = app.sandbox.leases()!;
        expect(next).not.toBe(old);
        await app.sandbox.start();
        // the new manager's start sweep spared it
        expect(fake.deletes).toEqual([]);
        hold.release();
        await until(() => fake.deletes.includes(hold.sandbox));
      },
      KEYS,
      fake,
    );
  });

  test("the default image follows a release's version, a dev build the dev tag", () => {
    expect(defaultImage("v1.2.3")).toBe(
      "ghcr.io/stefanprodan/1ctx-shell:v1.2.3",
    );
    expect(defaultImage("v1.2.3-rc.1")).toBe(
      "ghcr.io/stefanprodan/1ctx-shell:v1.2.3-rc.1",
    );
    expect(defaultImage("v0.0.0-dev")).toBe(
      "ghcr.io/stefanprodan/1ctx-shell:dev",
    );
    expect(defaultImage("main-abc123")).toBe(
      "ghcr.io/stefanprodan/1ctx-shell:dev",
    );
  });
});
