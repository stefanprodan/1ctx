// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The leases over a fake gateway and clock: one sandbox per workspace,
// the cap with creates and deletes counted, the pool, the sweeps and a
// gateway restart.

import { describe, expect, test } from "bun:test";
import type { ShellCall, ShellRepo } from "../../../src/server/bash/index.ts";
import { MINUTE_MS } from "../../../src/server/lib/clock.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  DELETE_RETRY_MS,
  DELETE_TIMEOUT_MS,
  GLOBAL_POLICY_REFUSAL,
  HEALTH_MS,
  INSTANCE_LABEL,
  KEEP_ALIVE,
  Leases,
  SANDBOX_ENV,
  type SandboxHold,
} from "../../../src/server/sandbox/index.ts";
import { rejection } from "../../helpers/async.ts";
import { fakeClock, fakeGateway, until } from "../../helpers/sandbox.ts";

const INSTANCE = "a1b2c3d4e5f6";

function setup(caps: Partial<typeof DEFAULT_LIMITS> = {}) {
  const time = fakeClock();
  const fake = fakeGateway();
  const held = new Map<string, number>();
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
    image: "ghcr.io/stefanprodan/1ctx-shell:dev",
    limits: () => limits,
    repos: {
      hold(tree) {
        held.set(tree, (held.get(tree) ?? 0) + 1);
        return () => held.set(tree, held.get(tree)! - 1);
      },
    },
  });
  const call = (id: string, repos: ShellRepo[] = []): ShellCall => ({
    projectId: "project",
    workspace: { id, sessionId: id.split(":")[0]! },
    sendId: "send",
    subagent: false,
    repos,
    repoFileBytes: 0,
    network: false,
    credentials: [],
  });
  const deadline = () => time.now() + 20_000;
  const acquire = async (id: string, repos: ShellRepo[] = []) => {
    const got = await leases.acquire(
      call(id, repos),
      deadline(),
      new AbortController().signal,
    );
    if (got === "busy") throw new Error("busy");
    return got;
  };
  const state = (sandbox: string) =>
    leases.rows().find((row) => row.sandbox === sandbox)?.state;
  return { time, fake, held, limits, leases, call, deadline, acquire, state };
}

const REPO: ShellRepo = { name: "app", tree: "/cache/trees/a/b/files" };

describe("sandbox leases", () => {
  test("a workspace's sandbox is made once, then reused", async () => {
    const t = setup();
    const hold = await t.acquire("chat");
    expect(t.fake.creates).toHaveLength(1);
    const spec = t.fake.creates[0]!;
    expect(spec.labels).toEqual({ [INSTANCE_LABEL]: INSTANCE });
    expect(spec.command).toEqual(KEEP_ALIVE);
    expect(spec.cpus).toBe(2);
    expect(spec.memoryMiB).toBe(2048);
    expect(spec.mounts.map((mount) => mount.target)).toEqual([
      "/knowledge",
      "/uploads",
      "/mcp",
      "/sandbox/.1ctx",
    ]);
    expect(spec.policy.readWrite).not.toContain("/sandbox");
    // the gateway refuses a longer name
    expect(hold.sandbox).toMatch(/^1ctx-[0-9a-z]{14}$/);
    expect(hold.keepAlivePid).toBe(7);
    // our own execs carry the image's environment, which no exec sees
    expect(t.fake.execs[0]!.environment).toEqual({ ...SANDBOX_ENV });
    expect(t.state(hold.sandbox)).toBe("leased");
    hold.release();
    expect(t.state(hold.sandbox)).toBe("idle");
    const again = await t.acquire("chat");
    expect(again.sandbox).toBe(hold.sandbox);
    expect(t.fake.creates).toHaveLength(1);
  });

  test("a sandbox without one keep-alive is never leased", async () => {
    const t = setup();
    t.fake.pid = 1;
    const error = await rejection(t.acquire("chat"));
    expect(error.message).toBe("the sandbox could not be made");
    await until(() => t.leases.rows().length === 0);
    expect(t.fake.deletes).toEqual([t.fake.creates[0]!.name]);
  });

  test("a repository mount that differs recycles the sandbox", async () => {
    const t = setup();
    const first = await t.acquire("chat", [REPO]);
    expect(t.fake.creates[0]!.mounts.at(-1)).toEqual({
      type: "bind",
      source: REPO.tree,
      target: "/repos/app",
    });
    first.release();
    const same = await t.acquire("chat", [REPO]);
    expect(same.sandbox).toBe(first.sandbox);
    same.release();
    const other = await t.acquire("chat", []);
    expect(other.sandbox).not.toBe(first.sandbox);
    expect(t.fake.deletes).toEqual([first.sandbox]);
  });

  test("a mounted tree stays held until its sandbox's delete is observed", async () => {
    const t = setup();
    t.fake.deleteMode = "pending";
    const hold = await t.acquire("chat", [REPO]);
    expect(t.held.get(REPO.tree)).toBe(1);
    hold.recycle("discard");
    await until(() => t.fake.deletes.length === 1);
    expect(t.state(hold.sandbox)).toBe("deleting");
    expect(t.held.get(REPO.tree)).toBe(1);
    t.fake.finish(hold.sandbox);
    await until(() => t.leases.rows().length === 0);
    expect(t.held.get(REPO.tree)).toBe(0);
  });

  test("an idle sandbox goes after sandboxIdleMinutes", async () => {
    const t = setup({ sandboxIdleMinutes: 5 });
    const hold = await t.acquire("chat");
    hold.release();
    t.time.advance(5 * MINUTE_MS - 1);
    expect(t.state(hold.sandbox)).toBe("idle");
    t.time.advance(1);
    await until(() => t.leases.rows().length === 0);
    expect(t.fake.deletes).toEqual([hold.sandbox]);
  });

  test("at the cap the least recently used idle sandbox goes, creating and deleting ones counted", async () => {
    const t = setup({ sandboxesMax: 2 });
    t.fake.deleteMode = "pending";
    const a = await t.acquire("a");
    t.time.advance(1000);
    const b = await t.acquire("b");
    a.release();
    t.time.advance(1000);
    b.release();
    const waiting = t.acquire("c");
    // a is the older: deleted, and still counted until it is gone
    await until(() => t.fake.deletes.length === 1);
    expect(t.fake.deletes).toEqual([a.sandbox]);
    expect(t.leases.counted()).toBe(2);
    expect(t.fake.creates).toHaveLength(2);
    t.fake.finish(a.sandbox);
    const c = await waiting;
    expect(t.fake.creates).toHaveLength(3);
    expect(t.state(b.sandbox)).toBe("idle");
    expect(t.state(c.sandbox)).toBe("leased");
  });

  test("with none idle at the cap a command ends busy at its deadline", async () => {
    const t = setup({ sandboxesMax: 1 });
    const a = await t.acquire("a");
    const deadline = t.deadline();
    const waiting = t.leases.acquire(
      t.call("b"),
      deadline,
      new AbortController().signal,
    );
    await until(() => t.time.sleeping().includes(deadline));
    t.time.advance(20_000);
    expect(await waiting).toBe("busy");
    // the one in use was never taken
    expect(t.state(a.sandbox)).toBe("leased");
    expect(t.fake.deletes).toEqual([]);
  });

  test("a create cut by the deadline ends busy and its sandbox goes", async () => {
    const t = setup();
    t.fake.hang("waitReady");
    const deadline = t.deadline();
    const waiting = t.leases.acquire(
      t.call("a"),
      deadline,
      new AbortController().signal,
    );
    await until(() => t.time.sleeping().includes(deadline));
    t.time.advance(20_000);
    expect(await waiting).toBe("busy");
    await until(() => t.leases.rows().length === 0);
    expect(t.fake.deletes).toEqual([t.fake.creates[0]!.name]);
  });

  test("a delete past its timeout is stuck, counted unless in error, never retried", async () => {
    const t = setup({ sandboxesMax: 1 });
    t.fake.deleteMode = "stuck";
    const a = await t.acquire("a");
    a.recycle("discard");
    await until(() => t.fake.deletes.length === 1);
    t.time.advance(DELETE_TIMEOUT_MS);
    // stuck, then its phase asked once and the next ask armed
    const next = t.time.now() + 5 * MINUTE_MS;
    await until(() => t.time.sleeping().includes(next));
    expect(t.state(a.sandbox)).toBe("stuck");
    expect(t.leases.rows()[0]!.phase).toBe("deleting");
    expect(t.leases.counted()).toBe(1);
    // the gateway marks its container exited: no longer counted
    t.fake.sandboxes.get(a.sandbox)!.phase = "error";
    t.time.advance(5 * MINUTE_MS);
    await until(() => t.leases.rows()[0]!.phase === "error");
    expect(t.state(a.sandbox)).toBe("stuck");
    expect(t.leases.counted()).toBe(0);
    expect(t.fake.deletes).toEqual([a.sandbox]);
    const b = await t.acquire("b");
    expect(b.sandbox).not.toBe(a.sandbox);
  });

  test("the warm pool fills in the background and serves only calls without repositories", async () => {
    const t = setup({ sandboxWarm: 1 });
    await t.leases.start();
    await until(() => t.leases.rows().some((row) => row.state === "warm"));
    const warm = t.leases.rows()[0]!.sandbox;
    const withRepo = await t.acquire("repo", [REPO]);
    expect(withRepo.sandbox).not.toBe(warm);
    const plain = await t.acquire("plain");
    expect(plain.sandbox).toBe(warm);
    // taken, so the pool makes another
    await until(() => t.leases.rows().some((row) => row.state === "warm"));
    expect(t.fake.creates).toHaveLength(3);
    t.leases.close();
  });

  test("at the cap a warm sandbox goes before an idle one", async () => {
    const t = setup({ sandboxesMax: 2, sandboxWarm: 1 });
    await t.leases.start();
    await until(() => t.leases.rows().some((row) => row.state === "warm"));
    const a = await t.acquire("a", [REPO]);
    a.release();
    const b = await t.acquire("b", [REPO]);
    const warm = t.fake.creates[0]!.name;
    expect(t.fake.deletes).toEqual([warm]);
    expect(t.state(a.sandbox)).toBe("idle");
    expect(t.state(b.sandbox)).toBe("leased");
    t.leases.close();
  });

  test("a recycle of a held sandbox waits for its release", async () => {
    const t = setup();
    const hold: SandboxHold = await t.acquire("chat:agent");
    t.leases.recycleSession("chat", "clear");
    expect(t.state(hold.sandbox)).toBe("leased");
    hold.release();
    await until(() => t.leases.rows().length === 0);
    expect(t.fake.deletes).toEqual([hold.sandbox]);
  });

  test("the start sweep deletes this instance's sandboxes and providers alone", async () => {
    const t = setup();
    t.fake.seed("1ctx-left-over", { [INSTANCE_LABEL]: INSTANCE });
    t.fake.seed("1ctx-other", { [INSTANCE_LABEL]: "other" });
    t.fake.seed("theirs", {});
    t.fake.providers.set("cred-a", { [INSTANCE_LABEL]: INSTANCE });
    t.fake.providers.set("cred-b", { [INSTANCE_LABEL]: "other" });
    await t.leases.start();
    expect(t.fake.deletes).toEqual(["1ctx-left-over"]);
    expect(t.fake.providerDeletes).toEqual(["cred-a"]);
    expect([...t.fake.sandboxes.keys()].sort()).toEqual([
      "1ctx-other",
      "theirs",
    ]);
    t.leases.close();
  });

  test("a gateway-global policy refuses every command", async () => {
    const t = setup();
    t.fake.globalPolicy = true;
    await t.leases.start();
    const error = await rejection(t.acquire("chat"));
    expect(error.message).toBe(GLOBAL_POLICY_REFUSAL);
    expect(t.fake.creates).toEqual([]);
    t.leases.close();
  });

  test("a gateway seen down then up drops every lease", async () => {
    const t = setup();
    await t.leases.start();
    const idle = await t.acquire("a");
    idle.release();
    const held = await t.acquire("b");
    t.fake.crash();
    t.time.advance(HEALTH_MS);
    // the failed probe arms the next one
    const probe = t.time.now() + HEALTH_MS;
    await until(() => t.time.sleeping().includes(probe));
    expect(t.fake.deletes).toEqual([]);
    t.fake.recover();
    t.time.advance(HEALTH_MS);
    await until(() => t.fake.deletes.includes(idle.sandbox));
    // the held one goes when its command ends
    expect(t.state(held.sandbox)).toBe("leased");
    held.release();
    await until(() => t.fake.deletes.includes(held.sandbox));
    const next = await t.acquire("a");
    expect(next.sandbox).not.toBe(idle.sandbox);
    t.leases.close();
  });

  test("a fast crash no probe saw down is found by the held sandbox in error", async () => {
    const t = setup();
    await t.leases.start();
    const idle = await t.acquire("a");
    idle.release();
    const held = await t.acquire("b");
    // down and back between two probes: the sandboxes are in error
    t.fake.crash();
    t.fake.recover();
    await t.leases.check();
    await until(() => t.fake.deletes.includes(idle.sandbox));
    expect(t.state(held.sandbox)).toBe("leased");
    held.release();
    await until(() => t.fake.deletes.includes(held.sandbox));
    t.leases.close();
  });

  test("an idle sandbox gone from the gateway is recycled by the probe", async () => {
    const t = setup();
    await t.leases.start();
    const idle = await t.acquire("a");
    idle.release();
    const held = await t.acquire("b");
    t.fake.sandboxes.delete(idle.sandbox);
    t.time.advance(HEALTH_MS);
    await until(() => t.leases.rows().length === 1);
    expect(t.state(held.sandbox)).toBe("leased");
    t.leases.close();
  });

  test("a failed exec recycles its lease and checks the rest at once", async () => {
    const t = setup();
    await t.leases.start();
    const other = await t.acquire("a");
    other.release();
    const failed = await t.acquire("b");
    t.fake.sandboxes.get(other.sandbox)!.phase = "error";
    t.fake.sandboxes.get(failed.sandbox)!.phase = "error";
    t.leases.sandboxFailed("b");
    // a held one in error: the gateway crashed, so every lease goes
    await until(() => t.fake.deletes.includes(other.sandbox));
    failed.release();
    await until(() => t.fake.deletes.includes(failed.sandbox));
    t.leases.close();
  });

  test("a delete that fails is asked again; only a timeout makes it stuck", async () => {
    const t = setup();
    const a = await t.acquire("a");
    t.fake.fail("delete");
    a.recycle("discard");
    await until(() =>
      t.time.sleeping().includes(t.time.now() + DELETE_RETRY_MS),
    );
    expect(t.state(a.sandbox)).toBe("deleting");
    t.fake.unfail("delete");
    t.time.advance(DELETE_RETRY_MS);
    await until(() => t.leases.rows().length === 0);
    expect(t.fake.deletes).toEqual([a.sandbox, a.sandbox]);
  });

  test("the restart sweep asks a stuck sandbox's delete again", async () => {
    const t = setup();
    await t.leases.start();
    t.fake.deleteMode = "stuck";
    const a = await t.acquire("a");
    a.recycle("discard");
    await until(() => t.fake.deletes.length === 1);
    t.time.advance(DELETE_TIMEOUT_MS);
    await until(() => t.state(a.sandbox) === "stuck");
    t.fake.deleteMode = "complete";
    await t.leases.restarted();
    await until(() => t.leases.rows().length === 0);
    expect(t.fake.deletes).toEqual([a.sandbox, a.sandbox]);
    t.leases.close();
  });

  test("a waiting command evicts once, not at every wake", async () => {
    const t = setup({ sandboxesMax: 2 });
    t.fake.deleteMode = "pending";
    const a = await t.acquire("a");
    t.time.advance(1000);
    const b = await t.acquire("b");
    a.release();
    t.time.advance(1000);
    b.release();
    const waiting = t.acquire("c");
    await until(() => t.fake.deletes.length === 1);
    // b taken and given back wakes the waiter while a's delete is pending
    const again = await t.acquire("b");
    again.release();
    // every wake the release made has run its loop
    for (let i = 0; i < 200; i++) await Promise.resolve();
    expect(t.fake.deletes).toEqual([a.sandbox]);
    expect(t.state(b.sandbox)).toBe("idle");
    t.fake.finish(a.sandbox);
    await waiting;
  });

  test("a start sweep that could not list runs at the next probe that can", async () => {
    const t = setup();
    t.fake.seed("1ctx-leftover0000", { [INSTANCE_LABEL]: INSTANCE });
    t.fake.fail("list");
    await t.leases.start();
    expect(t.fake.deletes).toEqual([]);
    t.fake.unfail("list");
    t.time.advance(HEALTH_MS);
    await until(() => t.fake.deletes.includes("1ctx-leftover0000"));
    t.leases.close();
  });

  test("one held sandbox in error goes alone, the others stay", async () => {
    const t = setup();
    await t.leases.start();
    const idle = await t.acquire("a");
    idle.release();
    const held = await t.acquire("b");
    t.fake.sandboxes.get(held.sandbox)!.phase = "error";
    await t.leases.check();
    expect(t.state(idle.sandbox)).toBe("idle");
    expect(t.state(held.sandbox)).toBe("leased");
    held.release();
    await until(() => t.fake.deletes.includes(held.sandbox));
    expect(t.fake.deletes).toEqual([held.sandbox]);
    expect(t.state(idle.sandbox)).toBe("idle");
    t.leases.close();
  });

  test("a create cut by its deadline that lands later is deleted by the probe", async () => {
    const t = setup();
    await t.leases.start();
    t.fake.hang("create");
    const deadline = t.deadline();
    const waiting = t.leases.acquire(
      t.call("a"),
      deadline,
      new AbortController().signal,
    );
    await until(() => t.time.sleeping().includes(deadline));
    t.time.advance(20_000);
    expect(await waiting).toBe("busy");
    const name = t.fake.creates[0]!.name;
    await until(() => t.leases.rows().length === 0);
    // the gateway makes it after its delete found nothing
    t.fake.seed(name, { [INSTANCE_LABEL]: INSTANCE });
    t.time.advance(HEALTH_MS);
    await until(() => t.fake.deletes.filter((n) => n === name).length === 2);
    expect(t.fake.sandboxes.has(name)).toBe(false);
    t.leases.close();
  });
});
