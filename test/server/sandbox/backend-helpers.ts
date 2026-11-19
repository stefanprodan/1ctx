// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandbox backend over the fake gateway and its filesystem: a job
// built from a few rows, a command played on the tree, and a settle as
// mount.ts gives it, the commit stood in for by its Landed.

import type {
  Answer,
  CommandCredential,
  Job,
  Mounted,
  Settled,
  SettleOutcome,
  ShellCall,
} from "../../../src/server/bash/index.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { sandboxBackend } from "../../../src/server/sandbox/backend.ts";
import { Leases, type SandboxHold } from "../../../src/server/sandbox/index.ts";
import type { SandboxNet } from "../../../src/shared/sandbox-net.ts";
import { fakeClock, fakeGateway, until } from "../../helpers/sandbox.ts";
import type {
  CommandCall,
  CommandEffect,
  FakeFs,
} from "../../helpers/sandbox-fs.ts";

export const bytes = (text: string) => new TextEncoder().encode(text);

export type Rows = {
  docs?: boolean;
  cwd?: string;
  // name to text; each doc's revision in revisions, 1 by default
  knowledge?: Record<string, string>;
  revisions?: Record<string, number>;
  // each doc's updated_at, 100 plus its revision by default
  times?: Record<string, number>;
  scratch?: Record<string, string | { text: string; mode: number }>;
  scratchRevision?: number;
  usedAt?: number | null;
  uploads?: Record<string, string>;
  uploadsRevision?: number;
  kept?: Record<string, string>;
  subagent?: boolean;
  ioBytes?: number;
  visuals?: boolean;
  // the sandbox network the command runs under, off when not given
  net?: SandboxNet;
  credentials?: CommandCredential[];
};

export function setup(caps: Partial<typeof DEFAULT_LIMITS> = {}) {
  const time = fakeClock();
  const fake = fakeGateway();
  const limits = { ...DEFAULT_LIMITS, ...caps };
  const gateway = fake.connect({
    endpoint: "https://g.test:1",
    ca: "",
    cert: "",
    key: "",
  });
  let net: SandboxNet = { mode: "off", hosts: [] };
  const leases = new Leases({
    clock: time.clock,
    log: silent,
    gateway,
    instanceId: "a1b2c3d4e5f6",
    image: "img",
    limits: () => limits,
    repos: { hold: () => () => {} },
    net: () => net,
  });
  const backend = sandboxBackend({
    clock: time.clock,
    log: silent,
    limits: () => limits,
  });
  const call = (rows: Rows = {}): ShellCall => {
    net = rows.net ?? { mode: "off", hosts: [] };
    return {
      projectId: "project",
      workspace: { id: "chat", sessionId: "chat" },
      sendId: "send",
      subagent: rows.subagent ?? false,
      repos: [],
      repoFileBytes: 0,
      network: true,
      credentials: rows.credentials ?? [],
    };
  };

  function jobOf(rows: Rows, command: string): { job: Job; mounted: Mounted } {
    const docs = rows.docs ?? true;
    const knowledge = Object.entries(docs ? (rows.knowledge ?? {}) : {});
    const scratchTime = rows.usedAt ?? 0;
    const timeOf = (name: string) =>
      rows.times?.[name] ?? 100 + (rows.revisions?.[name] ?? 1);
    const job: Job = {
      command,
      endsAt: time.now() + 20_000,
      docs,
      visuals: rows.visuals ?? false,
      network: false,
      cwd: rows.cwd ?? "/knowledge",
      knowledgeFileBytes: limits.knowledgeFileBytes,
      mountBytes: 1 << 26,
      ioBytes: rows.ioBytes ?? 1 << 20,
      iterations: 1000,
      knowledge: knowledge.map(([name, text]) => ({
        name,
        data: bytes(text),
        mtime: timeOf(name),
      })),
      scratch: Object.entries(rows.scratch ?? {}).map(([name, value]) => {
        const file =
          typeof value === "string" ? { text: value, mode: 0o644 } : value;
        return {
          name,
          data: bytes(file.text),
          mode: file.mode,
          mtime: scratchTime,
        };
      }),
      uploads: Object.entries(rows.uploads ?? {}).map(([name, text]) => ({
        name,
        data: bytes(text),
        mtime: 50,
      })),
      kept: Object.keys(rows.kept ?? {}),
      repos: [],
      repoFileBytes: 0,
      ...(rows.subagent ? { subagent: true } : {}),
    };
    const mounted: Mounted = {
      docs: knowledge.map(([name]) => ({
        id: `doc-${name}`,
        name,
        revision: rows.revisions?.[name] ?? 1,
        updatedAt: timeOf(name),
      })),
      scratch: {
        revision: rows.scratchRevision ?? 0,
        usedAt: rows.usedAt ?? null,
      },
      uploads: { sessionId: "chat", revision: rows.uploadsRevision ?? 0 },
      kept: Object.keys(rows.kept ?? {}).map((path, position) => ({
        messageId: "m",
        position,
        path,
        bytes: rows.kept![path]!.length,
      })),
    };
    return { job, mounted };
  }

  // one command: acquire, run with the effect played on the tree
  async function run(
    rows: Rows,
    effect:
      | CommandEffect
      | ((call: CommandCall) => CommandEffect | Promise<CommandEffect>) = {},
    options: {
      stop?: AbortController;
      deadline?: AbortController;
      reads?: number[];
      // the kept file's read throws, as a failed store read does
      keptFails?: boolean;
    } = {},
  ) {
    const hold = (await leases.acquire(
      call(rows),
      time.now() + 20_000,
      new AbortController().signal,
    )) as SandboxHold;
    const fs = fake.files.get(hold.sandbox)!;
    const failed = { count: 0 };
    const original = hold.failed;
    hold.failed = () => {
      failed.count++;
      original();
    };
    fs.onCommand = typeof effect === "function" ? effect : () => effect;
    const { job, mounted } = jobOf(rows, "cmd");
    const kept = Object.values(rows.kept ?? {});
    const phases: string[] = [];
    const ran = await backend.run(
      job,
      { ...call(rows), mounted, hold },
      {
        kept: (index) => {
          options.reads?.push(index);
          if (options.keptFails) throw new Error("store read failed");
          return bytes(kept[index]!);
        },
        fetch: null,
      },
      {
        signal: (options.stop ?? new AbortController()).signal,
        deadline: (options.deadline ?? new AbortController()).signal,
        chat: "chat",
        phase: (phase) => phases.push(phase),
      },
    );
    return { ...ran, hold, fs, job, mounted, phases, failed };
  }

  // what the commit would write for the answer, as mount.ts settles
  function landed(rows: Rows, answer: Answer, now = time.now()): SettleOutcome {
    const docs = (answer.changes?.knowledge ?? []).map((change) => ({
      name: change.name,
      id: `doc-${change.name}`,
      revision: (rows.revisions?.[change.name] ?? 1) + 1,
      updatedAt: now,
      text: change.text,
    }));
    return {
      landed: true,
      docs,
      scratch: { revision: (rows.scratchRevision ?? 0) + 1, usedAt: now },
    };
  }

  // the state of the hold's sandbox once its settle ended
  async function settled(hold: SandboxHold) {
    await backend.idle();
    await until(() => {
      const state = leases
        .rows()
        .find((row) => row.sandbox === hold.sandbox)?.state;
      return state !== "leased";
    });
    return (
      leases.rows().find((row) => row.sandbox === hold.sandbox)?.state ?? "gone"
    );
  }

  return { time, fake, limits, leases, backend, run, landed, settled, jobOf };
}

export const answerOf = (settled: Settled): Answer => {
  if (!settled.ok)
    throw new Error(`not ok: ${settled.cause} ${settled.error?.message}`);
  return settled.answer;
};

export const pushes = (fs: FakeFs) =>
  fs.calls.filter((step) => step === "push").length;
