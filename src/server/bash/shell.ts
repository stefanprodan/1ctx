// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The port a command's shell runs behind. mount.ts keeps the queue, the
// process slot, the mount and the commit; a backend runs the job and
// answers as the command worker does. The context is the server's and
// never reaches the command.

import type { Landed } from "./commit.ts";
import type { CommandCredential } from "./credentials.ts";
import type { Job } from "./protocol.ts";
import type {
  CommandHooks,
  CommandStops,
  CommandWorkers,
  Settled,
} from "./worker.ts";
import type { Workspace } from "./workspace.ts";

// a repository as the send prepared it: its tree is the cache folder of
// the pinned tree, mounted read-only at /repos/<name>
export type ShellRepo = { name: string; tree: string };

// what is known of a command before its mount: enough to pick and hold
// a shell for the workspace
export type ShellCall = {
  projectId: string;
  workspace: Workspace;
  sendId: string;
  subagent: boolean;
  repos: readonly ShellRepo[];
  repoFileBytes: number;
  // the send has web access; without it the sandbox has no network
  network: boolean;
  // the send's credentials, their keys read for this command
  credentials: readonly CommandCredential[];
  // what each tree's rows hold now, read only by a shell that sizes its
  // trees before the mount, so a lowered cap still mounts them
  stored?(): StoredBytes;
};

export type StoredBytes = {
  docs: number;
  uploads: number;
  kept: number;
};

// The identities of what the job's bytes were read from, so a backend
// that keeps a tree between commands knows what changed since. Uploads
// go by their session's revision, the parent's for a subagent, since a
// file's time can repeat when its content changes.
export type Mounted = {
  docs: readonly {
    id: string;
    name: string;
    revision: number;
    updatedAt: number;
  }[];
  // The pair is the identity: the revision restarts at 0 when a clear,
  // an archive or the idle sweep drops the row. usedAt is null with no
  // row.
  scratch: { revision: number; usedAt: number | null };
  uploads: { sessionId: string; revision: number };
  kept: readonly {
    messageId: string;
    position: number;
    path: string;
    bytes: number;
  }[];
};

// what acquire() took; released when the command never ran
export type ShellHold = { release(): void };

export type ShellContext = ShellCall & {
  mounted: Mounted;
  hold: ShellHold | null;
};

// How a command ended for the store, given once after it ran. Landed:
// what the transaction wrote, a doc's text as stored, which may differ
// from the file's bytes (a leading BOM is dropped). Skipped: nothing
// was committed (an exit at a deadline or limit, a refused tree, a
// failed or cancelled run). Thrown: a check or the commit threw, so
// nothing was written.
export type SettleOutcome =
  | ({ landed: true } & Landed)
  | { landed: false; why: "skipped" | "thrown" };

export type ShellRun = {
  settled: Settled;
  // called exactly once, after the commit landed, threw or was skipped
  settle(outcome: SettleOutcome): void;
};

export type ShellBackend = {
  // /tmp is the shell's own: no scratch row is mounted, and a command
  // writes or deletes none, only the cwd and the time of its last use
  ownTmp?: true;
  // a command may run to its caps' sandboxCommandMs, when the call
  // gives one, instead of the call timeout
  sandboxTimeout?: true;
  // Under the workspace's queue and before the process slot, so a
  // command waiting for its shell holds no slot. busy: none was free by
  // the deadline (ms since the epoch). Without it, nothing is held.
  acquire?(
    call: ShellCall,
    deadline: number,
    signal: AbortSignal,
  ): Promise<ShellHold | "busy">;
  // never rejects: a failure is a Settled that is not ok. Once called,
  // the hold is the backend's, and settle() gives it back
  run(
    job: Job,
    context: ShellContext,
    hooks: CommandHooks,
    stops: CommandStops,
  ): Promise<ShellRun>;
};

// just-bash in a worker per command: nothing is kept between commands,
// so there is nothing to hold or settle
export function builtinShell(workers: CommandWorkers): ShellBackend {
  return {
    run: async (job, _context, hooks, stops) => ({
      settled: await workers.run(job, hooks, stops),
      settle: () => {},
    }),
  };
}
