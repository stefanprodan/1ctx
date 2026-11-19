// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command in its chat's sandbox, which its subagents' commands share
// and run in at once (shared.ts). In the sandbox's turn the rows'
// difference from what it holds is pushed; the command runs once
// through the fixed wrapper; in the sandbox's turn again, a fence stops
// every process when no other command runs, and a complete walk, with
// the changed files pulled, is read by the same rules as just-bash's
// tree. After a landed commit the sandbox is put back to the stored
// rows, still in that turn. Beside other commands a save that did not
// land puts back only the docs a conflict names, and a stop of its own
// retires the sandbox, which goes after them; any other doubt recycles
// it, which stops them, so its trees commit once or not at all.

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
import { savedCwd, startNotice } from "../bash/index.ts";
import type { Clock } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import {
  emptyManifest,
  KEPT_FAILED,
  KeptUnreadable,
  manifestOf,
  type Wanted,
  wantedOf,
} from "./baseline.ts";
import { type Execs, isFolder, push, refusal, StepFailure } from "./execs.ts";
import { SandboxUnavailable } from "./gateway.ts";
import { commandId, launch } from "./launch.ts";
import type { RecycleReason, SandboxHold } from "./leases.ts";
import type { Readout } from "./readout.ts";
import {
  type Docs,
  docsNow,
  movedAtCommit,
  type Printed,
  putBack,
  RECYCLED,
  type Rows,
  readSaved,
} from "./save.ts";

export { RECYCLED } from "./save.ts";

import {
  alone,
  enter,
  freshTree,
  pushTarget,
  type Shared,
  sharedOf,
  withDocs,
} from "./shared.ts";
import { bounded } from "./waits.ts";

export type BackendDeps = {
  clock: Clock;
  log: Log;
  limits(): KnowledgeCaps;
};

export type SandboxRun = ShellBackend["run"];

type Ended = Extract<Settled, { ok: false }>;
type Landed = Extract<SettleOutcome, { landed: true }>;

class Command {
  private wanted: Wanted | null = null;
  // the docs the push read, which the save keeps unless the base moved
  private docs: Docs | null = null;
  private read: Readout | null = null;
  // the rows' docs as the save read them, for the put-back
  private fresh: Wanted | null = null;
  // what the save left in place beside other commands
  private left = new Set<string>();
  // beside other commands, what a conflict puts back; null for all
  private only: Set<string> | null = null;
  // a docs-off save that left /knowledge, so has none to put back
  private blind = false;
  // the rows the answer's changes were read against, for the commit
  rows: Rows | undefined;
  // recycle at settle, whatever lands
  private dirty = true;
  private settled = false;
  private reported = false;
  // the sandbox's turn, held from the save's walk to the put-back
  private pass: (() => void) | null = null;
  // the base's versions this command's rows are as new as and its push
  private seen: number;
  private pushed = 0;
  normalized: Promise<void> = Promise.resolve();
  private readonly hold: SandboxHold;
  private readonly shared: Shared;
  private readonly entered: ReturnType<typeof enter>;
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
    this.shared = sharedOf(this.hold.synced);
    this.entered = enter(this.shared, context.workspace.id, job.docs);
    // the job's rows were read just before, with no turn between
    this.seen = this.shared.version;
    this.stop = bounded(
      deps.clock,
      job.endsAt,
      AbortSignal.any([stops.signal, stops.deadline, this.hold.lost]),
      "the command's time ran out",
    );
    this.on = {
      gateway: this.hold.gateway,
      sandbox: this.hold.sandbox,
      signal: this.stop.signal,
    };
  }

  private late = () => this.deps.clock() >= this.job.endsAt;

  // a step's throw: a stop, the deadline's 124, a recycle or a failure
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
          stopped: "deadline",
        },
      };
    const failed = (words: string): Ended => ({
      ok: false,
      phase,
      cause: "error",
      notice,
      error: new Error(words),
    });
    if (this.hold.lost.aborted) return failed(RECYCLED);
    this.log(error);
    if (error instanceof KeptUnreadable) return failed(KEPT_FAILED);
    if (printed !== undefined && error instanceof StepFailure)
      return {
        ok: true,
        answer: { ...printed, changes: null, refused: refusal(error) },
      };
    return failed("the sandbox failed, so the command saved nothing");
  }

  // the gateway's word that the sandbox is gone: its lease goes now
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

  // the sandbox's turn; past a recycle nothing more goes to it
  private async turn(): Promise<() => void> {
    const pass = await this.hold.turn(this.stop.signal);
    if (!this.shared.broken) return pass;
    pass();
    throw new Error(RECYCLED);
  }

  // a folder before the command: the pushed tree's, or asked of the sandbox
  private async before(path: string): Promise<boolean> {
    const { job } = this;
    if (path === "/uploads") return true;
    if (path === "/knowledge") return job.docs;
    if (path === "/mcp") return job.kept.length > 0;
    const own = this.own(path);
    if (own !== null) return own;
    return this.wanted?.tree.get(path)?.kind === "dir";
  }

  // /tmp and the mounted repositories are never walked, so a folder
  // there is asked of the sandbox; null for a path elsewhere
  private own(path: string): Promise<boolean> | null {
    if (path === "/tmp") return Promise.resolve(true);
    if (path.startsWith("/tmp/")) return isFolder(this.on, path);
    if (path !== "/repos" && !path.startsWith("/repos/")) return null;
    if (this.job.repos.length === 0) return Promise.resolve(false);
    return path === "/repos" ? Promise.resolve(true) : isFolder(this.on, path);
  }

  async run(): Promise<Settled> {
    const { job, hold, shared } = this;
    const caps = this.deps.limits();
    let notice = "";
    let started = false;
    // waiting for the turn and running in the sandbox hold no process
    // slot; the read back takes one again, in its turn
    this.hooks.slot?.free();
    try {
      const pass = await this.turn();
      try {
        const mounted = wantedOf(
          job,
          this.context.mounted,
          this.hooks.kept,
          shared.base,
        );
        this.docs = job.docs
          ? docsNow({ shared, seen: this.seen, context: this.context, job })
          : null;
        this.wanted =
          this.docs === null ? mounted : withDocs(mounted, this.docs.wanted);
        const { target, owners } = pushTarget(
          shared,
          this.wanted,
          this.context.workspace.id,
          hold.workspace,
          job.docs,
        );
        const manifest = manifestOf(shared.base ?? new Map(), target);
        try {
          if (!emptyManifest(manifest)) await push(this.on, manifest);
        } catch (error) {
          // what the sandbox holds is unknown now
          shared.broken = true;
          throw error;
        }
        shared.base = target.tree;
        shared.owners = owners;
        this.seen = ++shared.version;
        this.pushed = this.seen;
        this.entered.pushed(this.pushed);
      } finally {
        pass();
      }
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
    const id = commandId();
    const ran = await launch(
      this.on,
      this.job,
      start,
      id,
      this.context.credentials,
    );
    const shown = { stdout: ran.stdout, stderr: ran.stderr, notice };
    // a lost launch is never tried again: the sandbox goes instead
    if (ran.code === null)
      return this.ended(ran.error, "run", notice, {
        ...shown,
        exitCode: 1,
        opened: [],
      });
    // our deadline is the clock's, never the command's own exit 124
    const ours = this.late();
    const printed = { ...shown, exitCode: ours ? 124 : ran.code, opened: [] };
    const stop = ours ? "deadline" : ran.refusedStart ? "limit" : null;
    if (stop !== null)
      return {
        ok: true,
        answer: { ...printed, changes: null, refused: null, stopped: stop },
      };
    try {
      // held until the settle's put-back, so saves never overlap; the
      // slot comes after, so no command waits for the turn holding one
      this.pass = await this.turn();
      await this.hooks.slot?.take(this.on.signal);
      return await this.readBack(id, start, printed, caps);
    } catch (error) {
      return this.ended(error, "run", notice, printed);
    }
  }

  private async readBack(
    id: string,
    start: string,
    printed: Printed,
    caps: KnowledgeCaps,
  ): Promise<Settled> {
    const saved = await readSaved(
      {
        on: this.on,
        hold: this.hold,
        job: this.job,
        context: this.context,
        shared: this.shared,
        wanted: this.wanted!,
        docs: this.docs,
        seen: this.seen,
        pushed: this.pushed,
        caps,
        phase: this.stops.phase,
        own: (path) => this.own(path),
        fenced: () => this.entered.fenced(),
        late: () => this.late(),
      },
      id,
      start,
      printed,
    );
    this.read = saved.read;
    this.fresh = saved.fresh;
    this.rows = saved.rows;
    this.dirty = saved.dirty;
    this.left = saved.left;
    this.only = saved.only;
    this.blind = saved.blind;
    return saved.settled;
  }

  settle(outcome: SettleOutcome): string | undefined {
    if (this.settled) return;
    this.settled = true;
    this.stop.dispose();
    const { shared, hold } = this;
    if (outcome.landed && !this.dirty && !shared.broken) {
      if (this.blind) this.release();
      else this.normalized = this.putBack(outcome.docs);
      return;
    }
    // a sibling's recycle leaves nothing to put back; alone, doubt recycles
    if (shared.broken || alone(shared)) {
      this.recycle("discard");
      this.done();
      return;
    }
    // beside others only a conflict puts back, never a sibling's work
    if (
      this.read !== null &&
      !this.read.discarded &&
      this.pass !== null &&
      !this.late()
    ) {
      const moved = movedAtCommit(outcome, this.context, shared.base!);
      if (moved !== null) ({ only: this.only, fresh: this.fresh } = moved);
      if (this.only === null) this.release();
      else this.normalized = this.putBack([]);
      return moved?.words;
    }
    // a stop of its own ends this command alone: what it started may run
    // on, so the sandbox goes once the others let go
    if (
      this.stops.signal.aborted ||
      this.stops.deadline.aborted ||
      this.late()
    ) {
      hold.retire("discard");
      this.done();
      return;
    }
    this.recycle("discard");
    this.done();
  }

  private release() {
    this.done();
    this.hold.release();
  }

  private putBack(docs: Landed["docs"]): Promise<void> {
    return this.normalize(docs).then(
      () => this.release(),
      (error: unknown) => {
        this.log(error);
        this.recycle("failed");
        this.done();
      },
    );
  }

  // the turn passed on and the command out of the sandbox's count
  private done() {
    this.pass?.();
    this.pass = null;
    this.entered.leave();
  }

  private recycle(reason: RecycleReason) {
    this.shared.broken = true;
    this.shared.base = null;
    this.hold.recycle(reason);
  }

  // the stored rows again: docs as stored, empty folders gone, modes rebuilt
  private normalize(docs: Landed["docs"]): Promise<void> {
    const step = bounded(
      this.deps.clock,
      this.job.endsAt,
      this.hold.lost,
      "the command's time ran out",
    );
    return putBack(
      { ...this.on, signal: step.signal },
      this.shared,
      this.read!,
      freshTree(this.shared.base!, this.fresh!, this.wanted!.bytes),
      docs,
      {
        alone: alone(this.shared),
        left: this.left,
        only: this.only,
      },
    ).finally(() => step.dispose());
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
          settle: () => void given?.release(),
        };
      const command = new Command(deps, job, context, hooks, stops);
      const settled = await command.run();
      return {
        settled,
        ...(command.rows === undefined ? {} : { rows: command.rows }),
        settle(outcome) {
          const words = command.settle(outcome);
          const done = command.normalized;
          pending.add(done);
          void done.finally(() => pending.delete(done));
          return words;
        },
      };
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
