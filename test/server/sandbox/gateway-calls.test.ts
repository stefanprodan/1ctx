// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The gateway's calls and what they leave there: the adapter ends an RPC
// with its signal, a create the gateway refused by name deletes nothing,
// and the probe sweeps labelled leftovers now and then on its own.

import { describe, expect, test } from "bun:test";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { OpenShell, SandboxPhase } from "openshell-sdk/raw";
import type {
  CommandCredential,
  ShellCall,
} from "../../../src/server/bash/index.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { NameTaken } from "../../../src/server/sandbox/gateway.ts";
import type {
  Connect,
  CreateSpec,
  SandboxHold,
} from "../../../src/server/sandbox/index.ts";
import {
  HEALTH_MS,
  INSTANCE_LABEL,
  Leases,
} from "../../../src/server/sandbox/index.ts";
import { gatewayOver } from "../../../src/server/sandbox/openshell.ts";
import { SWEEP_MS } from "../../../src/server/sandbox/watch.ts";
import { testApp } from "../../helpers/app.ts";
import { rejection, settle } from "../../helpers/async.ts";
import {
  type FakeGateway,
  fakeClock,
  fakeGateway,
  until,
} from "../../helpers/sandbox.ts";

const INSTANCE = "a1b2c3d4e5f6";
const KEY = "made-up-key-0123456789abcdef";
const CREDENTIAL: CommandCredential = {
  name: "quotes",
  prefix: "https://api.example.test/v1/",
  key: KEY,
  header: "Authorization",
  template: "Bearer {key}",
  value: `Bearer ${KEY}`,
  methods: ["GET", "HEAD"],
};

const callOf = (id: string): ShellCall => ({
  projectId: "project",
  workspace: { id, sessionId: id },
  root: id,
  sendId: "send",
  subagent: false,
  repos: [],
  repoFileBytes: 0,
  network: false,
  credentials: [],
});

function setup(caps: Partial<typeof DEFAULT_LIMITS> = {}) {
  const time = fakeClock();
  const fake = fakeGateway();
  const limits = { ...DEFAULT_LIMITS, ...caps };
  const leases = new Leases({
    clock: time.clock,
    log: silent,
    gateway: fake.connect({
      endpoint: "https://gateway.test:17670",
      ca: "ca",
      cert: "cert",
      key: "key",
    }),
    instanceId: INSTANCE,
    image: "img",
    limits: () => limits,
    repos: { hold: () => () => {} },
  });
  return { time, fake, leases, call: callOf };
}

const SPEC: CreateSpec = {
  name: "1ctx-x",
  labels: {},
  image: "img",
  command: ["sleep"],
  cpus: 1,
  memoryMiB: 64,
  policy: { readOnly: [], readWrite: [] },
  mounts: [],
};

// an RPC the gateway never answers, which records whether its caller
// ended it
function stalled() {
  const started: string[] = [];
  const ended: string[] = [];
  const hang =
    (method: string) => (_req: unknown, ctx: { signal: AbortSignal }) =>
      new Promise<never>((_, reject) => {
        started.push(method);
        ctx.signal.addEventListener("abort", () => {
          ended.push(method);
          reject(new ConnectError("cancelled", Code.Canceled));
        });
      });
  const transport = createRouterTransport(({ service }) => {
    service(OpenShell, {
      createSandbox: hang("create"),
      listSandboxes: hang("list"),
      updateConfig: hang("policy"),
    });
  });
  return { gateway: gatewayOver(transport, () => {}), started, ended };
}

// the in-memory transport runs a handler on later ticks
async function ticks(check: () => boolean) {
  for (let i = 0; i < 20 && !check(); i++) await settle();
}

describe("the gateway's calls", () => {
  test("a create, list or policy whose wait ends is cancelled at the gateway", async () => {
    const { gateway, started, ended } = stalled();
    const calls: [string, (signal: AbortSignal) => Promise<unknown>][] = [
      ["list", (signal) => gateway.list({ a: "b" }, signal)],
      ["create", (signal) => gateway.create(SPEC, signal)],
      [
        "policy",
        (signal) =>
          gateway.setPolicy(
            "1ctx-x",
            { readOnly: [], readWrite: [] },
            {},
            signal,
          ),
      ],
    ];
    for (const [method, run] of calls) {
      const ctl = new AbortController();
      const waiting = rejection(run(ctl.signal));
      await ticks(() => started.includes(method));
      ctl.abort(new Error("the step's time ran out"));
      await waiting;
      await ticks(() => ended.includes(method));
      expect(ended).toContain(method);
    }
  });

  test("the adapter reads a held name as NameTaken and folds each phase", async () => {
    const transport = createRouterTransport(({ service }) => {
      service(OpenShell, {
        createSandbox: () => {
          throw new ConnectError("sandbox exists", Code.AlreadyExists);
        },
        listSandboxes: () => ({
          sandboxes: [
            {
              metadata: { name: "1ctx-a", labels: { k: "v" } },
              status: { phase: SandboxPhase.STARTING },
            },
          ],
          nextPageToken: "",
        }),
        getSandbox: (req) => {
          if (req.name === "1ctx-a")
            return { sandbox: { status: { phase: SandboxPhase.STOPPING } } };
          throw new ConnectError("no such sandbox", Code.NotFound);
        },
      });
    });
    const gateway = gatewayOver(transport, () => {});
    const signal = new AbortController().signal;
    const error = await rejection(gateway.create(SPEC, signal));
    expect(error).toBeInstanceOf(NameTaken);
    expect(await gateway.list({ k: "v" }, signal)).toEqual([
      { name: "1ctx-a", phase: "provisioning", labels: { k: "v" } },
    ]);
    expect(await gateway.phase("1ctx-a", signal)).toBe("stopped");
    expect(await gateway.phase("1ctx-b", signal)).toBe("gone");
  });

  test("a create refused because the name is held deletes nothing", async () => {
    const t = setup();
    await t.leases.start();
    t.fake.fail("create", new NameTaken("sandbox already exists"));
    const error = await rejection(
      t.leases.acquire(
        t.call("chat"),
        t.time.now() + 20_000,
        new AbortController().signal,
      ),
    );
    expect(error.message).toBe("the sandbox could not be made");
    expect(t.fake.deletes).toEqual([]);
    expect(t.leases.rows()).toEqual([]);
    t.fake.unfail("create");
    t.leases.close();
  });

  test("a labelled sandbox and provider no lease holds go at the next periodic sweep", async () => {
    const t = setup();
    await t.leases.start();
    const hold = await t.leases.acquire(
      t.call("chat"),
      t.time.now() + 20_000,
      new AbortController().signal,
    );
    if (hold === "busy") throw new Error("busy");
    // left by a create the probes no longer look for
    t.fake.seed("1ctx-orphan000000", { [INSTANCE_LABEL]: INSTANCE });
    t.fake.providers.set("1ctx-orphan", { [INSTANCE_LABEL]: INSTANCE });
    for (let at = 0; at < SWEEP_MS; at += HEALTH_MS) {
      t.time.advance(HEALTH_MS);
      await t.leases.check();
    }
    await until(() => t.fake.deletes.includes("1ctx-orphan000000"));
    await until(() => t.fake.providerDeletes.includes("1ctx-orphan"));
    expect(t.fake.deletes).not.toContain(hold.sandbox);
    hold.release();
    t.leases.close();
  });
});

// the app on the gateways the connect picks by endpoint; each command
// holds a credential
async function onGateways(
  connect: Connect,
  body: (
    save: (endpoint: string) => Promise<void>,
    acquire: (chat: string) => Promise<SandboxHold>,
  ) => Promise<void>,
) {
  const app = await testApp({
    secrets: {
      "openshell-gateway-ca": "ca-pem-value",
      "openshell-gateway-cert": "cert-pem-value",
      "openshell-gateway-key": "key-pem-value",
    },
    sandboxGateway: connect,
  });
  try {
    const admin = app.client();
    await admin.signIn("admin");
    await body(
      async (endpoint) => {
        const res = await admin.call("PUT", "/api/admin/sandbox", {
          body: { backend: "openshell", endpoint },
        });
        expect(res.status).toBe(200);
      },
      async (chat) => {
        const hold = await app.sandbox
          .leases()!
          .acquire(
            { ...callOf(chat), network: true, credentials: [CREDENTIAL] },
            app.now.value + 20_000,
            new AbortController().signal,
          );
        if (hold === "busy") throw new Error("busy");
        return hold;
      },
    );
  } finally {
    await app.shutdown();
    app.db.close();
  }
}

const attachedTo = (fake: FakeGateway, sandbox: string) => [
  ...(fake.attached.get(sandbox) ?? []),
];

describe("two gateways", () => {
  test("a credential the new gateway attached still goes from the old one, profile included", async () => {
    const one = fakeGateway();
    const two = fakeGateway();
    const connect: Connect = (config) =>
      (config.endpoint === "https://one.test:17670" ? one : two).connect(
        config,
      );
    await onGateways(connect, async (save, acquire) => {
      await save("https://one.test:17670");
      const old = await acquire("a");
      const [provider] = attachedTo(one, old.sandbox);
      // the settings move on while a command runs on the old gateway
      await save("https://two.test:17670");
      const next = await acquire("b");
      const [mine] = attachedTo(two, next.sandbox);
      old.release();
      await until(() => one.providerDeletes.includes(provider!));
      // and its profile, which the new gateway's has no part in
      await until(() => one.profiles.size === 0);
      expect(two.profiles.size).toBe(1);
      expect(two.providers.has(mine!)).toBe(true);
      next.release();
    });
  });

  test("one gateway saved under a second endpoint keeps each manager's sandbox and provider", async () => {
    const fake = fakeGateway();
    await onGateways(fake.connect, async (save, acquire) => {
      await save("https://127.0.0.1:17670");
      const old = await acquire("a");
      const [provider] = attachedTo(fake, old.sandbox);
      await save("https://localhost:17670");
      const next = await acquire("b");
      const [mine] = attachedTo(fake, next.sandbox);
      // the new manager's start sweep leaves the old one's alone
      await settle();
      expect(fake.deletes).not.toContain(old.sandbox);
      expect(fake.providerDeletes).toEqual([]);
      expect(mine).not.toBe(provider);
      // the old one's release takes its own provider, never the new one's
      old.release();
      await until(() => fake.providerDeletes.includes(provider!));
      expect(fake.providerDeletes).toEqual([provider!]);
      expect(attachedTo(fake, next.sandbox)).toEqual([mine!]);
      next.release();
    });
  });
});
