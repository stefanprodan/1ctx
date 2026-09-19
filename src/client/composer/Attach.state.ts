// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The files added to a draft, apart from the view so every path is
// tested without a DOM. A picked file is judged by the server's rules,
// then staged one at a time, since the server admits one upload per
// user. An item ends staged, to be named by the send, or skipped, a
// line in the log that blocks nothing. The draft keeps the staged ids,
// so a reload brings them back from the project's staged list: until a
// list confirms them they are checked, and Send waits. Only a list
// loaded after an id was last known says it is gone. What each state
// says is Attach.words.ts.

import { signal } from "@preact/signals";
import type {
  StagedUpload,
  StagedUploads,
} from "../../shared/contracts/knowledge.ts";
import { isLeftOut } from "../../shared/knowledge.ts";
import { UPLOAD_RUNNING } from "../../shared/uploads.ts";
import { failure } from "../lib/format.ts";
import {
  type AttachItem,
  type AttachPorts,
  BLANK,
  EXPIRED,
  judgeFile,
  keyOf,
  NOT_SENT,
  savedOf,
  UNCHECKED,
} from "./Attach.model.ts";
import type { DraftUpload } from "./draft.ts";

export type { AttachItem, AttachPorts, AttachSkip } from "./Attach.model.ts";

const BUSY = new Set<AttachItem["phase"]>(["waiting", "sending", "checking"]);
// the server admits one upload per user, and an aborted one may hold its
// place for a moment: the next try waits instead of being refused
const ADMISSION_TRIES = 20;
const ADMISSION_WAIT_MS = 500;

export class AttachState {
  readonly items = signal<AttachItem[]>([]);
  readonly projectId = signal<string | null>(null);
  // a refusal of the whole pick, shown under the box
  readonly refusal = signal<string | null>(null);
  // picks being read and judged, not yet items
  private readonly reading = signal(0);
  private keys = 0;
  private live = true;
  private pumping = false;
  // moved by the X, a project switch and the end: a pick read under an
  // older one is dropped
  private epoch = 0;
  private adding: Promise<void> = Promise.resolve();
  private readonly tries = new Map<number, number>();
  private controller: AbortController | null = null;
  private sending: number | null = null;
  // staged ids the draft named that no list has confirmed yet
  private restore: DraftUpload[];
  // what the draft holds, as last written
  private kept: string;
  private readonly user: string | null;

  constructor(
    private readonly ports: AttachPorts,
    saved: readonly DraftUpload[],
  ) {
    this.user = ports.currentUser();
    this.restore = [...saved];
    this.kept = keyOf(saved);
  }

  // the items of the project the composer would send to
  get shown(): AttachItem[] {
    const projectId = this.projectId.value;
    return this.items.value.filter((item) => item.projectId === projectId);
  }
  get busy(): boolean {
    return (
      this.reading.value > 0 || this.shown.some((item) => BUSY.has(item.phase))
    );
  }
  // what a send carries
  get ids(): string[] {
    return this.shown.flatMap((item) =>
      item.phase === "staged" && item.id !== null ? [item.id] : [],
    );
  }

  // Home moved to another project: its queue dies with it, its staged
  // files are put away and come back with the project
  show(projectId: string): void {
    if (this.projectId.value === projectId) return;
    const left = this.projectId.value;
    this.projectId.value = projectId;
    this.refusal.value = null;
    this.move();
    if (left !== null) {
      // a saved id still being checked goes back to wait for its project
      for (const item of this.items.value) {
        if (
          item.projectId === left &&
          item.phase === "checking" &&
          item.id !== null
        ) {
          this.restore.push({ projectId: left, id: item.id, name: item.name });
        }
      }
      const gone = this.items.value.filter(
        (item) =>
          item.projectId === left && BUSY.has(item.phase) && item.id === null,
      );
      this.items.value = this.items.value.filter(
        (item) => item.projectId !== left || item.phase === "staged",
      );
      for (const item of gone) this.let(item);
    }
    // what the draft named for this project is checked until a list
    // confirms it, so a send never leaves it behind
    const since = this.ports.stamp();
    const named = this.restore.filter((saved) => saved.projectId === projectId);
    this.restore = this.restore.filter(
      (saved) => saved.projectId !== projectId,
    );
    this.items.value = [
      ...this.items.value,
      ...named
        .filter(
          (saved) => !this.items.value.some((item) => item.id === saved.id),
        )
        .map((saved) => ({
          ...this.blank(projectId, saved.name, false, 0, null),
          phase: "checking" as const,
          id: saved.id,
          since,
        })),
    ];
    this.reconcile(this.ports.list(projectId));
  }

  // the project's staged list said its word: restore what the draft
  // named, settle what was left checking, and move what is gone to the log
  reconcile(list: StagedUploads | null): void {
    const projectId = this.projectId.value;
    if (projectId === null || !this.alive()) return;
    if (list === null) {
      // nothing to check against yet: the list is asked for
      if (this.shown.some((item) => item.phase === "checking")) {
        this.ask(projectId);
      }
      return;
    }
    const held = new Map(list.items.map((item) => [item.id, item]));
    const byAttempt = new Map(list.items.map((item) => [item.attempt, item]));
    const asked = this.ports.asked(projectId);
    let ask = false;
    const next = this.items.value.map((item) => {
      if (item.projectId !== projectId) return item;
      if (item.phase === "staged" && item.id !== null && !held.has(item.id)) {
        return { ...item, phase: "skipped" as const, skip: EXPIRED, id: null };
      }
      if (item.phase !== "checking") return item;
      const found =
        item.id === null ? byAttempt.get(item.attempt) : held.get(item.id);
      if (found) return { ...this.fromStaged(projectId, found), key: item.key };
      // a list asked for before it went unknown proves nothing, however
      // late it answered: a newer one is asked
      if (asked <= item.since) {
        ask = true;
        return item;
      }
      if (item.id !== null) {
        return { ...item, phase: "skipped" as const, skip: EXPIRED, id: null };
      }
      // should the server turn out to hold it after all, it is deleted
      this.ports.forget(projectId, item.attempt);
      return { ...item, phase: "skipped" as const, skip: NOT_SENT };
    });
    this.put(next);
    if (ask) this.ask(projectId);
    void this.pump();
  }

  // a list is wanted for what is being checked. When none can be loaded
  // the checks end as skipped lines, so Send never waits on them forever
  private ask(projectId: string): void {
    void this.ports.reload(projectId).then((ok) => {
      if (ok || !this.alive()) return;
      this.put(
        this.items.value.map((item) => {
          if (item.projectId !== projectId || item.phase !== "checking") {
            return item;
          }
          if (item.id === null) this.ports.forget(projectId, item.attempt);
          return {
            ...item,
            phase: "skipped" as const,
            skip: item.id === null ? NOT_SENT : UNCHECKED,
            id: null,
          };
        }),
      );
      void this.pump();
    });
  }

  // picked, dropped or pasted files join the draft. Picks are taken one
  // after another, so two of them never count the same room, and while
  // one is read Send waits
  add(files: readonly File[], readable: boolean): Promise<void> {
    this.reading.value++;
    // taken at the pick, not when its turn comes: an X in between drops it
    const epoch = this.epoch;
    const run = this.adding.then(() => this.take(files, readable, epoch));
    this.adding = run.then(
      () => {},
      () => {},
    );
    return run.finally(() => {
      // a pick of an older epoch was already counted out by the move
      if (this.epoch === epoch) this.reading.value--;
    });
  }

  // the X, a project switch, the end: picks still being read are let go,
  // and the next pick does not wait behind them
  private move(): void {
    this.epoch++;
    this.reading.value = 0;
    this.adding = Promise.resolve();
  }

  private async take(
    files: readonly File[],
    readable: boolean,
    epoch: number,
  ): Promise<void> {
    const projectId = this.projectId.value;
    if (projectId === null || !this.alive() || this.epoch !== epoch) return;
    this.refusal.value = null;
    if (!readable) {
      this.refusal.value = "This agent cannot read files.";
      return;
    }
    if (this.ports.list(projectId) === null) {
      await this.ports.reload(projectId);
    }
    const limits = this.ports.list(projectId)?.limits;
    if (!this.alive() || this.epoch !== epoch) return;
    if (limits === undefined) {
      this.refusal.value = "The files could not be added. Try again.";
      return;
    }
    const fresh = files.filter(
      (file) =>
        !isLeftOut(file.name) &&
        !this.shown.some(
          (item) =>
            item.phase !== "skipped" &&
            item.file?.name === file.name &&
            item.file.size === file.size &&
            item.file.lastModified === file.lastModified,
        ),
    );
    const room = Math.max(
      0,
      limits.perMessage -
        this.shown.filter((item) => item.phase !== "skipped").length,
    );
    const taken = fresh.slice(0, room);
    const left = fresh.length - taken.length;
    if (left > 0) {
      this.refusal.value = `At most ${limits.perMessage} files per message. ${left} ${left === 1 ? "was" : "were"} left out.`;
    }
    for (const file of taken) {
      const verdict = await judgeFile(file, limits);
      // the X or a project switch while it was read: it never joins
      if (!this.alive() || this.epoch !== epoch) return;
      const item = this.blank(
        projectId,
        file.name,
        verdict.archive,
        file.size,
        file,
      );
      this.push(
        verdict.skip === null
          ? item
          : { ...item, phase: "skipped", skip: verdict.skip },
      );
    }
    void this.pump();
  }

  // one item goes: the one sending is aborted, a staged one deleted
  remove(key: number): void {
    const item = this.items.value.find((row) => row.key === key);
    if (item === undefined) return;
    this.put(this.items.value.filter((row) => row.key !== key));
    this.let(item);
  }

  // the X: everything of this project goes, the upload in flight too
  clear(): void {
    const projectId = this.projectId.value;
    const gone = this.shown;
    this.move();
    this.put(this.items.value.filter((item) => item.projectId !== projectId));
    this.refusal.value = null;
    for (const item of gone) this.let(item);
  }

  // a send went out with these: they are the chat's now, and the log of
  // what was skipped goes with them
  sent(ids: readonly string[]): void {
    const projectId = this.projectId.value;
    this.refusal.value = null;
    this.put(
      this.items.value.filter(
        (item) =>
          item.projectId !== projectId ||
          (item.phase !== "skipped" &&
            (item.id === null || !ids.includes(item.id))),
      ),
    );
  }

  dispose(): void {
    this.live = false;
    this.move();
    for (const item of this.items.value) {
      if (item.phase === "sending" || item.phase === "checking") {
        this.ports.forget(item.projectId, item.attempt);
      }
    }
    this.controller?.abort();
  }

  private alive(): boolean {
    if (this.live && this.ports.currentUser() !== this.user) this.dispose();
    return this.live;
  }

  private blank(
    projectId: string,
    name: string,
    archive: boolean,
    bytes: number,
    file: File | null,
  ): AttachItem {
    return {
      ...BLANK,
      key: ++this.keys,
      attempt: this.ports.mint(),
      projectId,
      name,
      archive,
      bytes,
      file,
    };
  }

  private fromStaged(projectId: string, staged: StagedUpload): AttachItem {
    return {
      ...this.blank(projectId, staged.name, staged.archive, staged.bytes, null),
      attempt: staged.attempt,
      folder: staged.folder,
      files: staged.files,
      phase: staged.id === null ? "skipped" : "staged",
      id: staged.id,
      skip: staged.id === null ? { type: "empty" } : null,
      members: staged.skipped,
      membersTotal: staged.skippedTotal,
    };
  }

  private push(item: AttachItem): void {
    this.put([...this.items.value, item]);
  }

  private change(key: number, patch: Partial<AttachItem>): void {
    this.put(
      this.items.value.map((item) =>
        item.key === key ? { ...item, ...patch } : item,
      ),
    );
  }

  // every change of what is staged is a change of the draft
  private put(next: AttachItem[]): void {
    this.items.value = next;
    // the draft is another composer's by now
    if (!this.live) return;
    const saved = savedOf(next, this.restore);
    const key = keyOf(saved);
    if (key === this.kept) return;
    this.kept = key;
    this.ports.save(saved);
  }

  // an item let go: its upload stops, and what it staged is deleted,
  // now when its id is known, else when a list shows its attempt
  private let(item: AttachItem): void {
    this.tries.delete(item.key);
    if (item.id !== null) {
      void this.ports.remove(item.projectId, item.id);
    } else if (item.phase === "sending" || item.phase === "checking") {
      this.ports.forget(item.projectId, item.attempt);
      if (this.sending === item.key) this.controller?.abort();
      void this.ports.reload(item.projectId);
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (!this.alive()) return;
        // an unanswered upload is settled by a list before the next goes
        if (this.shown.some((item) => item.phase === "checking")) return;
        const next = this.shown.find((item) => item.phase === "waiting");
        if (next === undefined || next.file === null) return;
        await this.send(next, next.file);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async send(item: AttachItem, file: File): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.sending = item.key;
    this.change(item.key, { phase: "sending" });
    const held = () => this.items.value.some((row) => row.key === item.key);
    try {
      const answer = await this.ports.stage(
        item.projectId,
        file,
        item.attempt,
        {
          signal: controller.signal,
          onProgress: (sent) => {
            if (!controller.signal.aborted && held()) {
              this.change(item.key, { sent: Math.min(sent, file.size) });
            }
          },
        },
      );
      if (!this.alive() || !held()) {
        // it was let go while the answer was on its way
        if (answer.id !== null)
          void this.ports.remove(item.projectId, answer.id);
        return;
      }
      this.change(item.key, {
        ...this.fromStaged(item.projectId, answer),
        key: item.key,
        name: item.name,
        file,
      });
    } catch (error) {
      if (!this.alive() || !held()) return;
      const f = failure(error);
      const tries = (this.tries.get(item.key) ?? 0) + 1;
      if (f.status === null) {
        // no answer: the server may hold it, so a list settles it
        this.change(item.key, {
          phase: "checking",
          since: this.ports.stamp(),
        });
        this.ask(item.projectId);
      } else if (
        f.status === 409 &&
        f.words === UPLOAD_RUNNING &&
        tries < ADMISSION_TRIES
      ) {
        this.tries.set(item.key, tries);
        this.change(item.key, { phase: "waiting", sent: 0 });
        await this.ports.wait(ADMISSION_WAIT_MS);
      } else {
        this.change(item.key, {
          phase: "skipped",
          skip: { type: "refused", words: f.words, status: f.status },
        });
      }
    } finally {
      if (this.sending === item.key) {
        this.sending = null;
        this.controller = null;
      }
    }
  }
}
