// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command in its workspace's sandbox. The rows' difference from what
// the sandbox holds is pushed, the command runs once through the fixed
// wrapper, a fence stops all it started, and a complete walk, with the
// changed files pulled, is read by the same rules as just-bash's tree.
// After a landed commit the sandbox is put back to the stored rows; any
// doubt instead recycles it, so its trees commit once or not at all.

import type {
  Answer,
  CommandHooks,
  CommandStops,
  Job,
  Settled,
  SettleOutcome,
  ShellBackend,
  ShellContext,
} from "../bash/index.ts";
import {
  discardNotices,
  exitAt,
  MAX_OPENS_PER_COMMAND,
  readBack,
  savedCwd,
  startNotice,
} from "../bash/index.ts";
import type { Clock } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import {
  committedTree,
  emptyManifest,
  heldSizes,
  KEPT_FAILED,
  KeptUnreadable,
  manifestOf,
  type Tree,
  type Wanted,
  wantedOf,
} from "./baseline.ts";
import {
  Capped,
  drain,
  type Execs,
  fence,
  isFolder,
  pull,
  push,
  refusal,
  removeRecords,
  StepFailure,
  walk,
} from "./execs.ts";
import { SANDBOX_ROOTS } from "./frames.ts";
import { SandboxUnavailable } from "./gateway.ts";
import { wrapperArgv } from "./helpers.ts";
import type { RecycleReason, SandboxHold } from "./leases.ts";
import {
  fill,
  openedOf,
  PATH_BYTES,
  RECORD_ROOTS,
  type Readout,
  readout,
  recordBounds,
  recordedCwd,
  recordRequests,
} from "./readout.ts";
import { scrubPulled } from "./scrub.ts";
import { SANDBOX_ENV, TREE_SLACK_BYTES } from "./spec.ts";
import { bounded } from "./waits.ts";

export type BackendDeps = {
  clock: Clock;
  log: Log;
  limits(): KnowledgeCaps;
};

export type SandboxRun = ShellBackend["run"];

// a fresh 128-bit id per command, base64url: no command guesses the next
export function commandId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
    "base64url",
  );
}

// The walk's bounds: what the caps allow, or what the trees held when
// that was more, so a tree over a lowered cap can still shrink.
export function walkBounds(caps: KnowledgeCaps, before: Tree | null) {
  const held = heldSizes(before);
  const tree = (root: string, cap: number) =>
    Math.max(cap, held.bytes.get(root) ?? 0) + TREE_SLACK_BYTES;
  const entries = Math.max(
    4 *
      (caps.knowledgeFiles +
        caps.scratchFiles +
        caps.uploadFiles +
        caps.mcpKeptFiles) +
      64,
    held.entries + 64,
  );
  const fileBytes = Math.max(
    caps.knowledgeFileBytes,
    caps.scratchBytes,
    caps.uploadBytes,
    caps.mcpKeptBytes,
    held.largest,
  );
  const totalBytes =
    tree("/knowledge", caps.knowledgeProjectBytes) +
    tree("/tmp", caps.scratchBytes) +
    tree("/uploads", caps.uploadBytes) +
    tree("/mcp", caps.mcpKeptBytes);
  return {
    limits: { entries, fileBytes, totalBytes },
    bounds: {
      entries: entries + 4,
      nameBytes: entries * PATH_BYTES,
      fileBytes: totalBytes,
    },
  };
}

type Ended = Extract<Settled, { ok: false }>;

class Command {
  private wanted: Wanted | null = null;
  private read: Readout | null = null;
  private changes: Answer["changes"] = null;
  // recycle at settle, whatever lands
  private dirty = true;
  private settled = false;
  private reported = false;
  normalized: Promise<void> = Promise.resolve();
  private readonly hold: SandboxHold;
  private readonly stop: { signal: AbortSignal; dispose(): void };
  private readonly on: Execs;

  constructor(
    private readonly deps: BackendDeps,
    private readonly job: Job,
    private readonly context: ShellContext,
    private readonly hooks: CommandHooks,
    private readonly stops: CommandStops,
  ) {
    this.hold = context.hold as SandboxHold;
    this.stop = bounded(
      deps.clock,
      job.endsAt,
      AbortSignal.any([stops.signal, stops.deadline]),
      "the command's time ran out",
    );
    this.on = {
      gateway: this.hold.gateway,
      sandbox: this.hold.sandbox,
      signal: this.stop.signal,
    };
  }

  private late = () => this.deps.clock() >= this.job.endsAt;

  // a step's throw: the caller's stop, the deadline's 124, or a failure
  private ended(
    error: unknown,
    phase: "mount" | "run",
    notice: string,
    printed?: Omit<Answer, "changes" | "refused">,
  ): Settled {
    this.lost(error);
    if (this.stops.signal.aborted)
      return { ok: false, phase, cause: "abort", notice };
    if (this.stops.deadline.aborted)
      return { ok: false, phase, cause: "deadline", notice };
    if (this.late())
      return {
        ok: true,
        answer: {
          ...(printed ?? { stdout: "", stderr: "", notice, opened: [] }),
          exitCode: 124,
          changes: null,
          refused: null,
        },
      };
    this.log(error);
    if (error instanceof KeptUnreadable)
      return {
        ok: false,
        phase,
        cause: "error",
        notice,
        error: new Error(KEPT_FAILED),
      };
    if (printed !== undefined && error instanceof StepFailure)
      return {
        ok: true,
        answer: { ...printed, changes: null, refused: refusal(error) },
      };
    const failed: Ended = {
      ok: false,
      phase,
      cause: "error",
      notice,
      error: new Error("the sandbox failed, so the command saved nothing"),
    };
    return failed;
  }

  // the gateway's word that the sandbox is gone: its lease goes now,
  // whatever else the step's throw means for the command
  private lost(error: unknown) {
    if (!(error instanceof SandboxUnavailable) || this.reported) return;
    this.reported = true;
    this.hold.failed();
  }

  private log(error: unknown) {
    this.lost(error);
    if (error instanceof StepFailure)
      this.deps.log.warn("sandbox step failed", {
        sandbox: this.hold.sandbox,
        step: error.step,
        reason: error.reason,
      });
    else
      this.deps.log.warn("sandbox step failed", {
        sandbox: this.hold.sandbox,
        ...errorFields(error),
      });
  }

  // a folder before the command: the pushed tree's, or a repository's
  private async before(path: string): Promise<boolean> {
    const { job } = this;
    if (path === "/tmp" || path === "/uploads") return true;
    if (path === "/knowledge") return job.docs;
    if (path === "/mcp") return job.kept.length > 0;
    if (path === "/repos" || path.startsWith("/repos/")) return this.repo(path);
    return this.wanted?.tree.get(path)?.kind === "dir";
  }

  private async repo(path: string): Promise<boolean> {
    if (this.job.repos.length === 0) return false;
    return path === "/repos" || isFolder(this.on, path);
  }

  async run(): Promise<Settled> {
    const { job, hold } = this;
    const caps = this.deps.limits();
    const before = hold.synced.value as Tree | null;
    let notice = "";
    let started = false;
    try {
      this.wanted = wantedOf(
        job,
        this.context.mounted,
        this.hooks.kept,
        before,
      );
      const manifest = manifestOf(before ?? new Map(), this.wanted);
      // what the sandbox holds is unknown until the push has ended
      hold.synced.value = null;
      if (!emptyManifest(manifest)) await push(this.on, manifest);
      hold.synced.value = this.wanted.tree;
      const start = await savedCwd(job.cwd, job.docs, (path) =>
        this.before(path),
      );
      notice = hold.notice + startNotice(job.cwd, start, job.docs);
      started = true;
      this.stops.phase?.("run");
      return await this.command(start, notice, caps);
    } catch (error) {
      return this.ended(error, started ? "run" : "mount", notice);
    }
  }

  private async command(
    start: string,
    notice: string,
    caps: KnowledgeCaps,
  ): Promise<Settled> {
    const { job } = this;
    const id = commandId();
    const open = !job.subagent;
    const stdout = new Capped(job.ioBytes);
    const stderr = new Capped(job.ioBytes);
    let code: number;
    try {
      code = await drain(
        this.on.gateway.exec({
          sandbox: this.on.sandbox,
          command: wrapperArgv({
            cwd: start,
            id,
            command: job.command,
            open: open
              ? {
                  docs: job.docs,
                  maxFiles: MAX_OPENS_PER_COMMAND,
                  knowledgeFileBytes: job.knowledgeFileBytes,
                  ...(job.repos.length > 0
                    ? { repoFileBytes: job.repoFileBytes }
                    : {}),
                }
              : null,
          }),
          environment: { ...SANDBOX_ENV },
          signal: this.on.signal,
        }),
        (stream, data) => (stream === "stdout" ? stdout : stderr).push(data),
      );
    } catch (error) {
      // a lost launch is never tried again: the sandbox goes instead
      return this.ended(error, "run", notice, {
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode: 1,
        notice,
        opened: [],
      });
    }
    const exitCode = exitAt(code, this.deps.clock(), job.endsAt);
    const printed = {
      stdout: stdout.text(),
      stderr: stderr.text(),
      exitCode,
      notice,
      opened: [] as Answer["opened"],
    };
    if (exitCode === 124)
      return { ok: true, answer: { ...printed, changes: null, refused: null } };
    try {
      return await this.readBack(id, start, printed, caps);
    } catch (error) {
      if (exitCode === 126 && !this.stops.signal.aborted && !this.late()) {
        this.lost(error);
        return {
          ok: true,
          answer: { ...printed, changes: null, refused: null },
        };
      }
      return this.ended(error, "run", notice, printed);
    }
  }

  private async readBack(
    id: string,
    start: string,
    printed: Omit<Answer, "changes" | "refused">,
    caps: KnowledgeCaps,
  ): Promise<Settled> {
    const { job, hold } = this;
    const wanted = this.wanted!;
    await fence(this.on, hold.keepAlivePid, hold.keepAliveStart);
    const { limits, bounds } = walkBounds(caps, wanted.tree);
    const walked = await walk(this.on, limits, bounds, SANDBOX_ROOTS);
    const read = readout(walked, job, wanted, this.context.credentials);
    this.read = read;
    const notice = discardNotices(read.entries, job) + printed.notice;
    this.stops.phase?.("diff");
    const shown = { ...printed, notice };
    if (printed.exitCode === 126)
      return { ok: true, answer: { ...shown, changes: null, refused: null } };
    const open = !job.subagent;
    const records = recordRequests(id, open);
    // a record holding a path is read with a path's bound, never a file's
    const paths = recordBounds(id, open);
    const named = [...paths.values()].reduce((sum, at) => sum + at, 0);
    const frames = await pull(
      this.on,
      [...read.pulls.keys(), ...records],
      {
        fileBytes: Math.max(limits.fileBytes, job.knowledgeFileBytes),
        totalBytes:
          limits.totalBytes +
          MAX_OPENS_PER_COMMAND * job.knowledgeFileBytes +
          named,
        paths,
      },
      [...SANDBOX_ROOTS, ...RECORD_ROOTS],
    );
    fill(read, frames);
    // a key the command was handed is never saved or shown
    const scrubbed = scrubPulled(read, frames, this.context.credentials);
    const pwd = recordedCwd(id, scrubbed) ?? start;
    const opened = open ? openedOf(id, scrubbed, job.visuals) : [];
    // every record goes, not only this command's: one command runs in
    // a sandbox at a time, and what a command left there would fill it
    await removeRecords(this.on);
    const back = await readBack(read.entries, job, {
      exitCode: printed.exitCode,
      start,
      pwd,
      isDirectory: (path) =>
        path === "/repos" || path.startsWith("/repos/")
          ? this.repo(path)
          : read.folders.has(path),
    });
    // the read back is the server's own work and may pass the deadline
    // after the last exec: what ends late saves nothing, as a late exec
    if (this.late())
      return {
        ok: true,
        answer: { ...printed, exitCode: 124, changes: null, refused: null },
      };
    this.changes = back.changes;
    // a change that cannot commit leaves a tree the rows do not hold
    this.dirty = back.changes === null || read.discarded;
    return { ok: true, answer: { ...shown, opened, ...back } };
  }

  settle(outcome: SettleOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.stop.dispose();
    if (!outcome.landed || this.dirty) {
      this.recycle("discard");
      return;
    }
    this.normalized = this.normalize(outcome).then(
      () => this.hold.release(),
      (error: unknown) => {
        this.log(error);
        this.recycle("failed");
      },
    );
  }

  private recycle(reason: RecycleReason) {
    this.hold.synced.value = null;
    this.hold.recycle(reason);
  }

  // the stored rows again: a doc as stored, scratch at its new time,
  // empty folders gone, every mode and time rebuilt
  private async normalize(
    landed: Extract<SettleOutcome, { landed: true }>,
  ): Promise<void> {
    const changes = this.changes!;
    const after = committedTree(this.wanted!, changes, landed);
    const manifest = manifestOf(this.read!.held, after, ["/knowledge", "/tmp"]);
    this.hold.synced.value = null;
    const step = bounded(
      this.deps.clock,
      this.job.endsAt,
      new AbortController().signal,
      "the command's time ran out",
    );
    try {
      if (!emptyManifest(manifest))
        await push({ ...this.on, signal: step.signal }, manifest);
    } finally {
      step.dispose();
    }
    this.hold.synced.value = after.tree;
  }
}

export type SandboxBackend = {
  run: SandboxRun;
  // every settle's normalization ended, for a test
  idle(): Promise<void>;
};

export function sandboxBackend(deps: BackendDeps): SandboxBackend {
  const pending = new Set<Promise<void>>();
  return {
    async run(job, context, hooks, stops) {
      const given = context.hold;
      if (given === null || !("sandbox" in given))
        return {
          settled: {
            ok: false,
            phase: "mount",
            cause: "error",
            notice: "",
            error: new Error("no sandbox is held for the command"),
          },
          settle: () => given?.release(),
        };
      const command = new Command(deps, job, context, hooks, stops);
      const settled = await command.run();
      return {
        settled,
        settle(outcome) {
          command.settle(outcome);
          const done = command.normalized;
          pending.add(done);
          void done.finally(() => pending.delete(done));
        },
      };
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
