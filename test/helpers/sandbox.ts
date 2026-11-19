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
  SandboxPhase,
} from "../../src/server/sandbox/index.ts";
import { KEEP_ALIVE_COMMAND } from "../../src/server/sandbox/index.ts";

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
  | "setPolicy";

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
  // what a command's exec answers, other than the keep-alive's
  onExec?: (request: ExecRequest) => ExecEvent[];
};

const text = (value: string) => new TextEncoder().encode(value);

export function fakeGateway(): FakeGateway {
  const failing = new Map<Method, Error>();
  const hanging = new Set<Method>();
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
    globalPolicy: false,
    pid: 7,
    deleteMode: "complete",
    fail: (method, error = new Error(`fake ${method} failed`)) =>
      failing.set(method, error),
    unfail: (method) => failing.delete(method),
    hang: (method) => hanging.add(method),
    finish(name) {
      fake.sandboxes.delete(name);
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
      for (const event of fake.onExec?.(request) ?? [{ exit: 0 }]) {
        yield event;
      }
    },
    async delete(name, signal) {
      fake.deletes.push(name);
      await enter("delete", signal);
      const box = fake.sandboxes.get(name);
      if (box === undefined) return;
      if (fake.deleteMode === "complete") fake.sandboxes.delete(name);
      else box.phase = box.phase === "error" ? "error" : "deleting";
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
      await enter("setPolicy", signal);
      fake.policies.push({ name, network });
    },
    providers: {
      async list(labels, signal) {
        await enter("list", signal);
        return [...fake.providers]
          .filter(([, have]) => matches(have, labels))
          .map(([name]) => name);
      },
      async delete(name, signal) {
        await enter("delete", signal);
        fake.providerDeletes.push(name);
        fake.providers.delete(name);
      },
    },
    close() {},
  };
  return fake;
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
