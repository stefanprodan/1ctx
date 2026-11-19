// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The leases of more than one manager on one gateway, as a settings
// change leaves them: a drained manager finishes its deletes, the cap
// counts every manager's sandboxes, and no sweep takes a provider a
// lease uses. Also a create a recycle doomed, a global policy removed,
// the image's root check and the trees sized from what is stored.

import { describe, expect, test } from "bun:test";
import type {
  CommandCredential,
  ShellCall,
  ShellRepo,
  StoredBytes,
} from "../../../src/server/bash/index.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  createSpec,
  DELETE_RETRY_MS,
  DELETE_TIMEOUT_MS,
  GLOBAL_POLICY_REFUSAL,
  INSTANCE_LABEL,
  Leases,
  type SandboxHold,
} from "../../../src/server/sandbox/index.ts";
import { planNetwork } from "../../../src/server/sandbox/netpolicy.ts";
import { POLICY_RECHECK_MS } from "../../../src/server/sandbox/policy.ts";
import {
  READ_ONLY_ROOTS,
  ROOTS_SCRIPT,
  rootProblems,
  WRITABLE_ROOTS,
} from "../../../src/server/sandbox/roots.ts";
import { TREE_SLACK_BYTES } from "../../../src/server/sandbox/spec.ts";
import { rejection, settle } from "../../helpers/async.ts";
import { fakeClock, fakeGateway, until } from "../../helpers/sandbox.ts";

const INSTANCE = "a1b2c3d4e5f6";
const MiB = 1024 * 1024;
const REPO: ShellRepo = { name: "app", tree: "/cache/trees/a/b/files" };
const CREDENTIAL: CommandCredential = {
  name: "quotes",
  prefix: "https://api.example.test/v1/",
  key: "made-up-key-0123456789abcdef",
  header: "Authorization",
  template: "Bearer {key}",
  value: "Bearer made-up-key-0123456789abcdef",
  methods: ["GET", "HEAD"],
};
const NET = { mode: "hosts" as const, hosts: ["api.example.test"] };
const PROVIDER = planNetwork({ credentials: [CREDENTIAL] }, NET, INSTANCE)
  .attach[0]!.provider;

function setup(caps: Partial<typeof DEFAULT_LIMITS> = {}) {
  const time = fakeClock();
  const fake = fakeGateway();
  const gateway = fake.connect({
    endpoint: "https://gateway.test:17670",
    ca: "ca",
    cert: "cert",
    key: "key",
  });
  // every provider delete asked, before the fake refuses an attached one
  const providerAsks: string[] = [];
  const remove = gateway.providers.delete;
  gateway.providers.delete = (name, signal) => {
    providerAsks.push(name);
    return remove(name, signal);
  };
  const held = new Map<string, number>();
  const limits = { ...DEFAULT_LIMITS, ...caps };
  const managers: Leases[] = [];
  const locks = new Map<string, Promise<unknown>>();
  const manager = (image = "img:1") => {
    const leases = new Leases({
      clock: time.clock,
      log: silent,
      gateway,
      instanceId: INSTANCE,
      image,
      limits: () => limits,
      repos: {
        hold(tree) {
          held.set(tree, (held.get(tree) ?? 0) + 1);
          return () => held.set(tree, held.get(tree)! - 1);
        },
      },
      others: () => managers,
      freed: () => {
        for (const other of managers) other.poke();
      },
      locks,
      net: () => NET,
    });
    managers.push(leases);
    return leases;
  };
  const call = (id: string, fields: Partial<ShellCall> = {}): ShellCall => ({
    projectId: "project",
    workspace: { id, sessionId: id },
    sendId: "send",
    subagent: false,
    repos: [],
    repoFileBytes: 0,
    network: true,
    credentials: [],
    ...fields,
  });
  const acquire = async (
    leases: Leases,
    id: string,
    fields: Partial<ShellCall> = {},
  ) => {
    const got = await leases.acquire(
      call(id, fields),
      time.now() + 20_000,
      new AbortController().signal,
    );
    if (got === "busy") throw new Error("busy");
    return got;
  };
  return { time, fake, providerAsks, held, limits, manager, call, acquire };
}

describe("managers of one gateway", () => {
  test("a drained manager asks a failed delete again, then lets its trees and client go", async () => {
    const t = setup();
    const old = t.manager();
    const hold = await t.acquire(old, "chat", { repos: [REPO] });
    hold.release();
    t.fake.fail("delete");
    let drained = false;
    void old.drain().then(() => {
      drained = true;
    });
    await until(() =>
      t.time.sleeping().includes(t.time.now() + DELETE_RETRY_MS),
    );
    expect(old.rows()[0]!.state).toBe("deleting");
    t.fake.unfail("delete");
    t.time.advance(DELETE_RETRY_MS);
    await until(() => drained);
    expect(old.rows()).toEqual([]);
    expect(t.held.get(REPO.tree)).toBe(0);
  });

  test("a drained manager keeps no stuck delete: its trees go and a sweep takes the name", async () => {
    const t = setup();
    const old = t.manager();
    const hold = await t.acquire(old, "chat", { repos: [REPO] });
    t.fake.deleteMode = "stuck";
    let drained = false;
    void old.drain().then(() => {
      drained = true;
    });
    hold.release();
    await until(() => t.fake.deletes.length === 1);
    t.time.advance(DELETE_TIMEOUT_MS);
    await until(() => drained);
    expect(t.held.get(REPO.tree)).toBe(0);
    t.fake.deleteMode = "complete";
    const next = t.manager("img:2");
    await next.start();
    expect(t.fake.deletes).toEqual([hold.sandbox, hold.sandbox]);
    next.close();
  });

  test("a drained manager's sandboxes count against the cap until their deletes are observed", async () => {
    const t = setup({ sandboxesMax: 1 });
    t.fake.deleteMode = "pending";
    const old = t.manager();
    const hold = await t.acquire(old, "a");
    void old.drain();
    const next = t.manager("img:2");
    const waiting = t.acquire(next, "b");
    await until(() => t.time.sleeping().includes(t.time.now() + 20_000));
    expect(t.fake.creates).toHaveLength(1);
    hold.release();
    await until(() => t.fake.deletes.includes(hold.sandbox));
    expect(t.fake.creates).toHaveLength(1);
    t.fake.finish(hold.sandbox);
    const made = await waiting;
    expect(made.sandbox).toBe(t.fake.creates[1]!.name);
    next.close();
  });

  test("a command waiting in a drained manager is refused", async () => {
    const t = setup({ sandboxesMax: 1 });
    const old = t.manager();
    await t.acquire(old, "a");
    const waiting = t.acquire(old, "b");
    await until(() => t.time.sleeping().includes(t.time.now() + 20_000));
    void old.drain();
    const error = await rejection(waiting);
    expect(error.message).toBe(
      "the sandbox settings changed: run the command again",
    );
  });

  test("no sweep deletes a provider a drained manager's lease still uses", async () => {
    const t = setup();
    const old = t.manager();
    const hold = await t.acquire(old, "chat", {
      credentials: [CREDENTIAL],
    });
    void old.drain();
    const next = t.manager("img:2");
    await next.start();
    expect(t.providerAsks).toEqual([]);
    expect(t.fake.deletes).toEqual([]);
    hold.release();
    await until(() => t.fake.providerDeletes.includes(PROVIDER));
    next.close();
  });

  test("a drained manager settles once its providers' deletes ended", async () => {
    const t = setup();
    const old = t.manager();
    const hold = await t.acquire(old, "chat", {
      credentials: [CREDENTIAL],
    });
    const gateway = t.fake.connect(t.fake.configs[0]!);
    let asked = false;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const remove = gateway.providers.delete;
    gateway.providers.delete = async (name, signal) => {
      asked = true;
      await gate;
      return remove(name, signal);
    };
    let drained = false;
    void old.drain().then(() => {
      drained = true;
    });
    hold.release();
    await until(() => asked && old.rows().length === 0);
    await settle();
    expect(drained).toBe(false);
    open();
    await until(() => drained);
    expect(t.fake.providerDeletes).toEqual([PROVIDER]);
    expect(t.fake.profileDeletes).toHaveLength(1);
  });

  test("a drained manager's last provider keeps a profile another manager uses", async () => {
    const t = setup();
    const old = t.manager();
    const hold = await t.acquire(old, "a", {
      credentials: [CREDENTIAL],
    });
    const drained = old.drain();
    const next = t.manager("img:2");
    const key = "made-up-key-rotated-0123456789";
    const other = await t.acquire(next, "b", {
      credentials: [{ ...CREDENTIAL, key, value: `Bearer ${key}` }],
    });
    hold.release();
    await drained;
    expect(t.fake.providerDeletes).toEqual([PROVIDER]);
    expect(t.fake.profileDeletes).toEqual([]);
    other.release();
    next.close();
  });

  test("a sweep asks each provider again right before its delete", async () => {
    const t = setup();
    const leases = t.manager();
    t.fake.providers.set("1ctx-left-over", { [INSTANCE_LABEL]: INSTANCE });
    t.fake.providers.set(PROVIDER, { [INSTANCE_LABEL]: INSTANCE });
    // a command takes the second while the first's delete runs
    let taking: Promise<SandboxHold> | null = null;
    const gateway = t.fake.connect(t.fake.configs[0]!);
    const remove = gateway.providers.delete;
    gateway.providers.delete = async (name, signal) => {
      if (name === "1ctx-left-over" && taking === null) {
        taking = t.acquire(leases, "chat", {
          credentials: [CREDENTIAL],
        });
        await until(() => t.fake.calls.includes(`attach:${PROVIDER}`));
      }
      return remove(name, signal);
    };
    await leases.restarted();
    const hold = await taking!;
    expect(t.providerAsks).toEqual(["1ctx-left-over"]);
    expect(t.fake.providers.has(PROVIDER)).toBe(true);
    hold.release();
    leases.close();
  });
});

describe("a create", () => {
  test("a sandbox a recycle doomed while it was made is deleted, never handed out", async () => {
    const t = setup();
    const leases = t.manager();
    let doomed = false;
    t.fake.onFiles = () => {
      if (doomed) return;
      doomed = true;
      leases.recycle("chat", "clear");
    };
    const hold = await t.acquire(leases, "chat");
    const [first, second] = t.fake.creates;
    expect(hold.sandbox).toBe(second!.name);
    await until(() => t.fake.deletes.includes(first!.name));
    expect(leases.rows().map((row) => row.sandbox)).toEqual([second!.name]);
  });

  test("a sandbox the settings doomed while it was made is deleted, and the command refused", async () => {
    const t = setup();
    const leases = t.manager();
    let drained: Promise<void> | null = null;
    t.fake.onFiles = () => {
      drained ??= leases.drain();
    };
    const error = await rejection(t.acquire(leases, "chat"));
    expect(error.message).toBe(
      "the sandbox settings changed: run the command again",
    );
    await drained!;
    expect(t.fake.deletes).toEqual([t.fake.creates[0]!.name]);
  });

  test("a global policy removed lets commands run again at the next ask", async () => {
    const t = setup();
    const leases = t.manager();
    t.fake.globalPolicy = true;
    await leases.start();
    expect(leases.refused()).toBe(GLOBAL_POLICY_REFUSAL);
    let error = await rejection(t.acquire(leases, "chat"));
    expect(error.message).toBe(GLOBAL_POLICY_REFUSAL);
    t.fake.globalPolicy = false;
    // asked at most once per POLICY_RECHECK_MS
    error = await rejection(t.acquire(leases, "chat"));
    expect(error.message).toBe(GLOBAL_POLICY_REFUSAL);
    t.time.advance(POLICY_RECHECK_MS);
    const hold = await t.acquire(leases, "chat");
    expect(t.fake.creates).toHaveLength(1);
    expect(leases.refused()).toBeNull();
    hold.release();
    leases.close();
  });
});

describe("the image's roots", () => {
  test("the check covers every root the policy and the mounts name", () => {
    expect([...WRITABLE_ROOTS, ...READ_ONLY_ROOTS].sort()).toEqual(
      [
        "/knowledge",
        "/tmp",
        "/uploads",
        "/mcp",
        "/repos",
        "/opt/home",
        "/sandbox/tmp",
        "/sandbox/.1ctx",
      ].sort(),
    );
    for (const root of WRITABLE_ROOTS) expect(ROOTS_SCRIPT).toContain(root);
    expect(rootProblems(0, "ok\n")).toEqual([]);
    expect(rootProblems(0, "missing /repos\nunwritable /tmp\nok\n")).toEqual([
      "missing /repos",
      "unwritable /tmp",
    ]);
    // anything else is no answer, never a pass
    expect(rootProblems(1, "ok\n")).toBeNull();
    expect(rootProblems(0, "missing /repos\n")).toBeNull();
    expect(rootProblems(0, "missing /etc\nok\n")).toBeNull();
  });

  test("the first sandbox of the image is checked, once", async () => {
    const t = setup();
    const leases = t.manager();
    const a = await t.acquire(leases, "a");
    const b = await t.acquire(leases, "b");
    expect(t.fake.rootChecks).toEqual([a.sandbox]);
    expect(b.sandbox).not.toBe(a.sandbox);
    // a new image is checked again
    const next = t.manager("img:2");
    const c = await t.acquire(next, "c");
    expect(t.fake.rootChecks).toEqual([a.sandbox, c.sandbox]);
  });

  test("an image that fails the check refuses every command and says why", async () => {
    const t = setup({ sandboxWarm: 1 });
    t.fake.rootProblems = ["missing /repos"];
    const leases = t.manager();
    await leases.start();
    await until(() => leases.refused() !== null);
    const why =
      "the sandbox image img:1 fails its root check (missing /repos). An admin must fix the image or pick another";
    expect(leases.refused()).toBe(why);
    await until(() => leases.rows().length === 0);
    const error = await rejection(t.acquire(leases, "chat"));
    expect(error.message).toBe(why);
    // nothing more is made, the pool included
    expect(t.fake.creates).toHaveLength(1);
    expect(t.fake.deletes).toEqual([t.fake.creates[0]!.name]);
    leases.close();
  });
});

describe("tree sizes", () => {
  const stored: StoredBytes = {
    docs: 300 * MiB,
    scratch: 1,
    uploads: 0,
    kept: 0,
  };

  test("a tree over a lowered cap is sized to what it holds", () => {
    const caps = { ...DEFAULT_LIMITS, knowledgeProjectBytes: 100 * MiB };
    const spec = createSpec({
      name: "1ctx-x",
      instanceId: INSTANCE,
      image: "img",
      caps,
      repos: [],
      stored,
    });
    const size = (target: string) =>
      spec.mounts.find((mount) => mount.target === target);
    expect(size("/knowledge")).toMatchObject({
      sizeBytes: 300 * MiB + TREE_SLACK_BYTES,
    });
    expect(size("/tmp")).toMatchObject({
      sizeBytes: caps.scratchBytes + TREE_SLACK_BYTES,
    });
  });

  test("a call whose stored trees exceed the caps never takes a warm sandbox", async () => {
    const t = setup({ sandboxWarm: 1, knowledgeProjectBytes: 100 * MiB });
    const leases = t.manager();
    await leases.start();
    await until(() => leases.rows().some((row) => row.state === "warm"));
    const warm = leases.rows()[0]!.sandbox;
    const hold = await t.acquire(leases, "chat", { stored: () => stored });
    expect(hold.sandbox).not.toBe(warm);
    const made = t.fake.creates.find((spec) => spec.name === hold.sandbox)!;
    expect(
      made.mounts.find((mount) => mount.target === "/knowledge"),
    ).toMatchObject({ sizeBytes: 300 * MiB + TREE_SLACK_BYTES });
    const small = await t.acquire(leases, "other", {
      stored: () => ({ ...stored, docs: 1 }),
    });
    expect(small.sandbox).toBe(warm);
    leases.close();
  });
});
