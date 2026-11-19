// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An OpenShell gateway in memory: it records every create, exec,
// delete and policy, and can be told to fail a call, hang it until its
// signal ends it, hold deletes pending or stuck, or crash and come back
// with every sandbox in error, as a gateway killed mid-flight does.

import type {
  Connect,
  CreateSpec,
  ExecEvent,
  ExecRequest,
  Gateway,
  GatewayConfig,
  ProfileSpec,
  ProviderSpec,
  ProviderState,
  SandboxPhase,
} from "../../src/server/sandbox/index.ts";
import { KEEP_ALIVE_COMMAND } from "../../src/server/sandbox/index.ts";
import { START_TIME_COMMAND } from "../../src/server/sandbox/keepalive.ts";
import { ROOTS_COMMAND } from "../../src/server/sandbox/roots.ts";
import { FakeFs } from "./sandbox-fs.ts";

type Method =
  | "health"
  | "globalPolicy"
  | "create"
  | "waitReady"
  | "exec"
  | "delete"
  | "waitDeleted"
  | "phase"
  | "list"
  | "setPolicy"
  | "importProfile"
  | "put"
  | "attach"
  | "state"
  // a provider's or profile's list and delete, apart from a sandbox's
  | "providerList"
  | "providerDelete";

type Box = { phase: SandboxPhase; labels: Record<string, string> };

export type FakeGateway = {
  connect: Connect;
  configs: GatewayConfig[];
  sandboxes: Map<string, Box>;
  providers: Map<string, Record<string, string>>;
  creates: CreateSpec[];
  execs: ExecRequest[];
  deletes: string[];
  providerDeletes: string[];
  policies: { name: string; network: Record<string, unknown> }[];
  // the endpointless profiles, by id, with their annotations
  profiles: Map<string, ProfileSpec>;
  profileDeletes: string[];
  // every put, its key included: the keys a test makes up
  puts: ProviderSpec[];
  // the providers attached to each sandbox
  attached: Map<string, Set<string>>;
  // the order of the network's calls: attach:<provider>,
  // policy:<sandbox>, state:<provider>
  calls: string[];
  // a provider's readiness; by default withheld until a policy of the
  // sandbox binds it, then ready
  providerState?: (sandbox: string, provider: string) => ProviderState;
  globalPolicy: boolean;
  // the keep-alive's pid each sandbox reports
  pid: number;
  // how a delete ends: at once, held until finish(), or never
  deleteMode: "complete" | "pending" | "stuck";
  // the next calls of a method throw this, until unfail
  fail(method: Method, error?: Error): void;
  unfail(method: Method): void;
  // the next calls of a method wait until their signal ends them
  hang(method: Method): void;
  // the next calls of a method wait until the returned resume runs;
  // paused counts the calls waiting
  pause(method: Method): () => void;
  paused: number;
  // a pending delete observed
  finish(name: string): void;
  // the gateway is unreachable; recover() brings it back with every
  // sandbox in error
  crash(): void;
  recover(): void;
  // a sandbox another process left under a label
  seed(
    name: string,
    labels: Record<string, string>,
    phase?: SandboxPhase,
  ): void;
  // the keep-alive's start time each sandbox reports
  started: string;
  // what the root check prints before its ok, as "missing /repos"
  rootProblems: string[];
  // the root checks run, by sandbox
  rootChecks: string[];
  // each sandbox's filesystem, which answers the helpers' execs
  files: Map<string, FakeFs>;
  // every new sandbox's filesystem is set up by this, as a test asks
  onFiles?: (name: string, fs: FakeFs) => void;
  // what an exec answers in place of the filesystem's
  onExec?: (request: ExecRequest) => ExecEvent[];
};

const text = (value: string) => new TextEncoder().encode(value);

export function fakeGateway(): FakeGateway {
  const failing = new Map<Method, Error>();
  const hanging = new Set<Method>();
  const pausing = new Map<Method, Promise<void>>();
  const pending = new Map<string, () => void>();
  let down = false;
  const fake: FakeGateway = {
    connect: (config) => {
      fake.configs.push(config);
      return gateway;
    },
    configs: [],
    sandboxes: new Map(),
    providers: new Map(),
    creates: [],
    execs: [],
    deletes: [],
    providerDeletes: [],
    policies: [],
    profiles: new Map(),
    profileDeletes: [],
    puts: [],
    attached: new Map(),
    calls: [],
    globalPolicy: false,
    pid: 7,
    started: "4242",
    rootProblems: [],
    rootChecks: [],
    files: new Map(),
    deleteMode: "complete",
    fail: (method, error = new Error(`fake ${method} failed`)) =>
      failing.set(method, error),
    unfail: (method) => failing.delete(method),
    hang: (method) => hanging.add(method),
    pause(method) {
      let resume = () => {};
      pausing.set(
        method,
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
      );
      return () => {
        pausing.delete(method);
        resume();
      };
    },
    paused: 0,
    finish(name) {
      fake.sandboxes.delete(name);
      fake.attached.delete(name);
      pending.get(name)?.();
      pending.delete(name);
    },
    crash() {
      down = true;
    },
    recover() {
      down = false;
      for (const box of fake.sandboxes.values()) box.phase = "error";
    },
    seed(name, labels, phase = "ready") {
      fake.sandboxes.set(name, { phase, labels });
    },
  };
  // a hung call ends only with its signal, as a stalled RPC does
  const enter = async (method: Method, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (down) throw new Error("fake gateway unreachable");
    const error = failing.get(method);
    if (error) throw error;
    if (hanging.has(method)) await until(signal);
    const gate = pausing.get(method);
    if (gate !== undefined) {
      fake.paused++;
      await gate;
      fake.paused--;
    }
  };
  const until = (signal: AbortSignal) =>
    new Promise<never>((_, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  const matches = (
    have: Record<string, string>,
    want: Record<string, string>,
  ) => Object.entries(want).every(([key, value]) => have[key] === value);
  const gateway: Gateway = {
    async health(signal) {
      await enter("health", signal);
      return { healthy: true, version: "0.1.9" };
    },
    async globalPolicy(signal) {
      await enter("globalPolicy", signal);
      return fake.globalPolicy;
    },
    async create(spec, signal) {
      fake.creates.push(spec);
      await enter("create", signal);
      fake.sandboxes.set(spec.name, { phase: "ready", labels: spec.labels });
      const files = new FakeFs();
      fake.files.set(spec.name, files);
      fake.onFiles?.(spec.name, files);
    },
    async waitReady(name, signal) {
      await enter("waitReady", signal);
      if (fake.sandboxes.get(name)?.phase !== "ready") {
        throw new Error("sandbox not ready");
      }
    },
    async *exec(request) {
      fake.execs.push(request);
      await enter("exec", request.signal);
      const keepAlive =
        request.command.join("\0") === KEEP_ALIVE_COMMAND.join("\0");
      if (keepAlive) {
        yield { stream: "stdout", data: text(`${fake.pid}\n`) };
        yield { exit: 0 };
        return;
      }
      const started =
        request.command.slice(0, -1).join("\0") ===
        START_TIME_COMMAND.join("\0");
      if (started) {
        const stat = `${fake.pid} (sleep) S ${"0 ".repeat(18)}${fake.started} 0 0\n`;
        yield { stream: "stdout", data: text(stat) };
        yield { exit: 0 };
        return;
      }
      if (request.command.join("\0") === ROOTS_COMMAND.join("\0")) {
        fake.rootChecks.push(request.sandbox);
        const lines = [...fake.rootProblems, "ok"].join("\n");
        yield { stream: "stdout", data: text(`${lines}\n`) };
        yield { exit: 0 };
        return;
      }
      if (fake.onExec) {
        for (const event of fake.onExec(request)) yield event;
        return;
      }
      const files = fake.files.get(request.sandbox);
      if (files === undefined) throw new Error("no such sandbox");
      yield* files.exec(request);
    },
    async delete(name, signal) {
      fake.deletes.push(name);
      await enter("delete", signal);
      const box = fake.sandboxes.get(name);
      if (box === undefined) return;
      if (fake.deleteMode === "complete") {
        fake.sandboxes.delete(name);
        fake.attached.delete(name);
      } else box.phase = box.phase === "error" ? "error" : "deleting";
    },
    async waitDeleted(name, signal) {
      await enter("waitDeleted", signal);
      if (!fake.sandboxes.has(name)) return;
      if (fake.deleteMode === "stuck") return until(signal);
      await Promise.race([
        new Promise<void>((resolve) => pending.set(name, resolve)),
        until(signal),
      ]);
    },
    async phase(name, signal) {
      await enter("phase", signal);
      return fake.sandboxes.get(name)?.phase ?? "gone";
    },
    async list(labels, signal) {
      await enter("list", signal);
      return [...fake.sandboxes]
        .filter(([, box]) => matches(box.labels, labels))
        .map(([name, box]) => ({ name, phase: box.phase, labels: box.labels }));
    },
    async setPolicy(name, _policy, network, signal) {
      fake.calls.push(`policy:${name}`);
      await enter("setPolicy", signal);
      // as OpenShell, a binding to a provider not attached refuses all
      for (const provider of bindings(network)) {
        if (!fake.attached.get(name)?.has(provider)) {
          throw new Error(`provider ${provider} is not attached`);
        }
      }
      fake.policies.push({ name, network });
    },
    providers: {
      async list(labels, signal) {
        await enter("providerList", signal);
        return [...fake.providers]
          .filter(([, have]) => matches(have, labels))
          .map(([name]) => name);
      },
      async delete(name, signal) {
        await enter("providerDelete", signal);
        for (const set of fake.attached.values()) {
          if (set.has(name)) throw new Error(`provider ${name} is attached`);
        }
        fake.providerDeletes.push(name);
        fake.providers.delete(name);
      },
      async importProfile(profile, signal) {
        await enter("importProfile", signal);
        if (!fake.profiles.has(profile.id)) {
          fake.profiles.set(profile.id, profile);
        }
      },
      async profiles(annotations, signal) {
        await enter("providerList", signal);
        return [...fake.profiles.values()]
          .filter((profile) => matches(profile.annotations, annotations))
          .map((profile) => profile.id);
      },
      async deleteProfile(id, signal) {
        await enter("providerDelete", signal);
        fake.profileDeletes.push(id);
        fake.profiles.delete(id);
      },
      async put(spec, signal) {
        await enter("put", signal);
        if (!fake.profiles.has(spec.profile)) {
          throw new Error(`profile ${spec.profile} not found`);
        }
        fake.puts.push(spec);
        if (!fake.providers.has(spec.name)) {
          fake.providers.set(spec.name, spec.labels);
        }
      },
      async attach(sandbox, provider, signal) {
        fake.calls.push(`attach:${provider}`);
        await enter("attach", signal);
        if (!fake.providers.has(provider)) {
          throw new Error(`provider ${provider} not found`);
        }
        const set = fake.attached.get(sandbox) ?? new Set();
        set.add(provider);
        fake.attached.set(sandbox, set);
      },
      async state(sandbox, provider, signal) {
        fake.calls.push(`state:${provider}`);
        await enter("state", signal);
        if (fake.providerState) return fake.providerState(sandbox, provider);
        const latest = fake.policies.findLast((one) => one.name === sandbox);
        return latest !== undefined &&
          bindings(latest.network).includes(provider)
          ? "ready"
          : "withheld";
      },
    },
    close() {},
  };
  return fake;
}

// the providers a network policy binds
export function bindings(network: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const rule of Object.values(network) as {
    endpoints: { credentialBinding?: { provider: string } }[];
  }[]) {
    for (const endpoint of rule.endpoints) {
      if (endpoint.credentialBinding) {
        out.push(endpoint.credentialBinding.provider);
      }
    }
  }
  return out;
}

// a clock that moves only when told, as testApp's does
export function fakeClock(start = 1_000_000) {
  let current = start;
  const sleepers = new Set<{ at: number; resolve: () => void }>();
  const clock = Object.assign(() => current, {
    sleep: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        const sleeper = { at: current + ms, resolve };
        sleepers.add(sleeper);
        signal?.addEventListener("abort", () => sleepers.delete(sleeper), {
          once: true,
        });
      }),
  });
  return {
    clock,
    now: () => current,
    advance(ms: number) {
      current += ms;
      for (const sleeper of [...sleepers]) {
        if (sleeper.at > current) continue;
        sleepers.delete(sleeper);
        sleeper.resolve();
      }
    },
    sleeping: () => [...sleepers].map((sleeper) => sleeper.at),
  };
}

// microtask turns until the check holds: the leases' background work is
// all promises on the fake gateway and clock, so no real time passes
export async function until(check: () => boolean, turns = 2000) {
  for (let i = 0; i < turns; i++) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error("never held");
}
