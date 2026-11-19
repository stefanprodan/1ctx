// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The network of a sandbox commands share: they run under one plan, so a
// command whose network or credentials differ waits for the sandbox to
// go and gets another, never widening or ending a running one's, and a
// failed setup sends the commands waiting for it to another sandbox.

import { describe, expect, test } from "bun:test";
import type {
  CommandCredential,
  ShellCall,
} from "../../../src/server/bash/index.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { Leases, type SandboxHold } from "../../../src/server/sandbox/index.ts";
import type { SandboxNet } from "../../../src/shared/sandbox-net.ts";
import { rejection, settle } from "../../helpers/async.ts";
import { fakeClock, fakeGateway, until } from "../../helpers/sandbox.ts";

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
const LISTED: SandboxNet = { mode: "hosts", hosts: ["api.example.test"] };
const OFF: SandboxNet = { mode: "off", hosts: [] };

function setup() {
  const time = fakeClock();
  const fake = fakeGateway();
  let net: SandboxNet = OFF;
  const leases = new Leases({
    clock: time.clock,
    log: silent,
    gateway: fake.connect({
      endpoint: "https://gateway.test:17670",
      ca: "ca",
      cert: "cert",
      key: "key",
    }),
    instanceId: "a1b2c3d4e5f6",
    image: "img",
    limits: () => DEFAULT_LIMITS,
    repos: { hold: () => () => {} },
    net: () => net,
  });
  // a command of the chat or of one of its subagents, in its sandbox
  const acquire = (
    given: SandboxNet,
    credentials: CommandCredential[] = [],
  ) => {
    net = given;
    const call: ShellCall = {
      projectId: "project",
      workspace: { id: "chat", sessionId: "chat" },
      root: "chat",
      sendId: "send",
      subagent: false,
      repos: [],
      repoFileBytes: 0,
      network: true,
      credentials,
    };
    return leases.acquire(
      call,
      time.now() + 20_000,
      new AbortController().signal,
    ) as Promise<SandboxHold>;
  };
  return { time, fake, leases, acquire };
}

// whether the promise is still pending after the leases' work ran
async function pending(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await settle();
  return !done;
}

describe("a shared sandbox's network", () => {
  for (const [what, first, next] of [
    ["the network turned on", [OFF, []], [LISTED, []]],
    ["a credential added", [LISTED, []], [LISTED, [CREDENTIAL]]],
    ["a credential removed", [LISTED, [CREDENTIAL]], [LISTED, []]],
    ["the network turned off", [LISTED, []], [OFF, []]],
  ] as const) {
    test(`${what} beside a running command waits for another sandbox`, async () => {
      const t = setup();
      const running = await t.acquire(first[0], [...first[1]]);
      const policies = t.fake.policies.length;
      const attached = t.fake.attached.get(running.sandbox)?.size ?? 0;
      const waiting = t.acquire(next[0], [...next[1]]);
      expect(await pending(waiting)).toBe(true);
      // the running command keeps the network it was admitted with
      expect(t.fake.policies).toHaveLength(policies);
      expect(t.fake.attached.get(running.sandbox)?.size ?? 0).toBe(attached);
      expect(running.lost.aborted).toBe(false);
      running.release();
      const other = await waiting;
      expect(other.sandbox).not.toBe(running.sandbox);
      await until(() => t.fake.deletes.includes(running.sandbox));
      other.release();
    });
  }

  test("a command that retired the sandbox goes on at the last release, before its delete ends", async () => {
    const t = setup();
    t.fake.deleteMode = "pending";
    const running = await t.acquire(LISTED, []);
    const waiting = t.acquire(LISTED, [CREDENTIAL]);
    expect(await pending(waiting)).toBe(true);
    running.release();
    const other = await waiting;
    expect(other.sandbox).not.toBe(running.sandbox);
    expect(t.fake.sandboxes.get(running.sandbox)?.phase).toBe("deleting");
    other.release();
    t.fake.finish(running.sandbox);
  });

  test("commands with one plan share the sandbox, the first ones at once", async () => {
    const t = setup();
    const [a, b] = await Promise.all([
      t.acquire(LISTED, [CREDENTIAL]),
      t.acquire(LISTED, [CREDENTIAL]),
    ]);
    expect(b.sandbox).toBe(a.sandbox);
    a.release();
    const c = await t.acquire(LISTED, [CREDENTIAL]);
    expect(c.sandbox).toBe(a.sandbox);
    b.release();
    c.release();
    // alone, a new plan changes it in place
    const d = await t.acquire(LISTED, []);
    expect(d.sandbox).not.toBe(a.sandbox);
    d.release();
    const e = await t.acquire(LISTED, [CREDENTIAL]);
    expect(e.sandbox).toBe(d.sandbox);
    e.release();
  });

  test("a command waiting for a setup that failed goes to another sandbox", async () => {
    const t = setup();
    let state: "pending" | "failed" = "pending";
    t.fake.providerState = () => state;
    const first = rejection(t.acquire(LISTED, [CREDENTIAL]));
    // the first holds the sandbox's turn, polling its provider
    await until(() => t.time.sleeping().includes(t.time.now() + 50));
    const second = t.acquire(LISTED, [CREDENTIAL]);
    await until(() => t.leases.rows()[0]?.state === "leased");
    await settle();
    state = "failed";
    t.time.advance(50);
    expect((await first).message).toBe(
      "the sandbox network could not be set up",
    );
    const failed = t.fake.creates[0]!.name;
    t.fake.providerState = undefined;
    const hold = await second;
    expect(hold.sandbox).not.toBe(failed);
    await until(() => t.fake.deletes.includes(failed));
    hold.release();
  });
});
