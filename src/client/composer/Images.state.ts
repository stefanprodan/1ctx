// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The images added to a draft, apart from the view so every path is
// tested without a DOM. Each is staged one at a time, since the server
// admits one upload per user, files included, and ends staged, to be
// named by the send, or refused with the server's words. The draft
// keeps the staged ids, so a reload brings them back: each is asked
// about once and, gone, drops without a word, as the server keeps no
// list of them to read.

import { signal } from "@preact/signals";
import { UPLOAD_RUNNING } from "../../shared/uploads.ts";
import { failure } from "../lib/format.ts";
import type { DraftImage } from "./draft.ts";
import type { ImageItem, ImagePorts } from "./Images.model.ts";

export type { ImageItem, ImagePorts } from "./Images.model.ts";

const BUSY = new Set<ImageItem["phase"]>(["waiting", "sending", "checking"]);
// the uploads share one line in the tab (data/upload-line.ts); a 409
// is an upload from elsewhere, another tab's, and the next try waits
const ADMISSION_TRIES = 20;
const ADMISSION_WAIT_MS = 500;

const keyOf = (images: readonly DraftImage[]) =>
  images.map((image) => `${image.projectId}/${image.id}`).join(" ");

export class ImageState {
  readonly items = signal<ImageItem[]>([]);
  readonly projectId = signal<string | null>(null);
  private keys = 0;
  private live = true;
  private pumping = false;
  private readonly tries = new Map<number, number>();
  private controller: AbortController | null = null;
  private sending: number | null = null;
  // staged ids the draft named for a project not shown yet
  private restore: DraftImage[];
  private kept: string;
  private readonly user: string | null;

  constructor(
    private readonly ports: ImagePorts,
    saved: readonly DraftImage[],
  ) {
    this.user = ports.currentUser();
    this.restore = [...saved];
    this.kept = keyOf(saved);
  }

  get shown(): ImageItem[] {
    const projectId = this.projectId.value;
    return this.items.value.filter((item) => item.projectId === projectId);
  }
  get busy(): boolean {
    return this.shown.some((item) => BUSY.has(item.phase));
  }
  // what a send carries, in the order they were added
  get ids(): string[] {
    return this.shown.flatMap((item) =>
      item.phase === "staged" && item.id !== null ? [item.id] : [],
    );
  }

  // Home moved to another project: its uploads in flight are let go, its
  // staged images are put away and come back with it
  show(projectId: string): void {
    if (this.projectId.value === projectId) return;
    const left = this.projectId.value;
    this.projectId.value = projectId;
    if (left !== null) {
      const gone = this.items.value.filter(
        (item) => item.projectId === left && item.id === null,
      );
      this.put(
        this.items.value.filter(
          (item) => item.projectId !== left || item.id !== null,
        ),
      );
      for (const item of gone) this.let(item);
    }
    const named = this.restore.filter((saved) => saved.projectId === projectId);
    this.restore = this.restore.filter(
      (saved) => saved.projectId !== projectId,
    );
    const fresh = named
      .filter((saved) => !this.items.value.some((item) => item.id === saved.id))
      .map((saved) => ({
        ...this.blank(projectId, saved.name, 0, null),
        phase: "checking" as const,
        id: saved.id,
      }));
    this.put([...this.items.value, ...fresh]);
    for (const item of fresh) void this.check(item);
  }

  add(files: readonly File[]): void {
    const projectId = this.projectId.value;
    if (projectId === null || !this.alive() || files.length === 0) return;
    this.put([
      ...this.items.value,
      ...files.map((file) => this.blank(projectId, file.name, file.size, file)),
    ]);
    void this.pump();
  }

  // one image goes: a staged one is deleted, an upload stopped
  remove(key: number): void {
    const item = this.items.value.find((row) => row.key === key);
    if (item === undefined) return;
    this.put(this.items.value.filter((row) => row.key !== key));
    this.let(item);
  }

  // a send went out with these: they are the chat's now, and the
  // refusals go with them
  sent(ids: readonly string[]): void {
    const projectId = this.projectId.value;
    this.put(
      this.items.value.filter(
        (item) =>
          item.projectId !== projectId ||
          (item.phase !== "refused" &&
            (item.id === null || !ids.includes(item.id))),
      ),
    );
  }

  // the claim found one gone: sent by an answer that never came back,
  // from another tab, or past its lease. Its bytes route may still
  // answer, so none is asked about: all go, the ones still staged
  // deleted, and the failure's words say to add them again
  gone(): void {
    if (!this.alive()) return;
    const projectId = this.projectId.value;
    const dropped = this.shown.filter((item) => item.id !== null);
    this.put(
      this.items.value.filter(
        (item) => item.projectId !== projectId || item.id === null,
      ),
    );
    for (const item of dropped) void this.ports.remove(projectId!, item.id!);
  }

  dispose(): void {
    this.live = false;
    const item = this.items.value.find((row) => row.key === this.sending);
    if (item !== undefined) this.stop(item);
  }

  private alive(): boolean {
    if (this.live && this.ports.currentUser() !== this.user) this.dispose();
    return this.live;
  }

  private blank(
    projectId: string,
    name: string,
    bytes: number,
    file: File | null,
  ): ImageItem {
    return {
      key: ++this.keys,
      projectId,
      name,
      bytes,
      phase: "waiting",
      sent: 0,
      id: null,
      words: null,
      status: null,
      file,
    };
  }

  private change(key: number, patch: Partial<ImageItem>): void {
    this.put(
      this.items.value.map((item) =>
        item.key === key ? { ...item, ...patch } : item,
      ),
    );
  }

  private put(next: ImageItem[]): void {
    this.items.value = next;
    if (!this.live) return;
    const saved = [
      ...this.restore,
      ...next.flatMap((item) =>
        (item.phase === "staged" || item.phase === "checking") &&
        item.id !== null
          ? [{ projectId: item.projectId, id: item.id, name: item.name }]
          : [],
      ),
    ];
    const key = keyOf(saved);
    if (key === this.kept) return;
    this.kept = key;
    this.ports.save(saved);
  }

  private held(key: number): boolean {
    return this.items.value.some((row) => row.key === key);
  }

  // a draft's id the server no longer has drops quietly; an answer that
  // says neither keeps it, and the send's refusal tells
  private async check(item: ImageItem): Promise<void> {
    const held = await this.ports.check(item.projectId, item.id!);
    if (!this.alive() || !this.held(item.key)) return;
    if (held === false) {
      this.put(this.items.value.filter((row) => row.key !== item.key));
    } else this.change(item.key, { phase: "staged" });
  }

  // an item let go: a staged one is deleted, an upload still sending
  // its bytes is stopped, and one whose bytes all went is let finish,
  // since the server may stage it anyway: its answer is deleted
  private let(item: ImageItem): void {
    this.tries.delete(item.key);
    if (item.id !== null) void this.ports.remove(item.projectId, item.id);
    else if (item.phase === "sending") this.stop(item);
  }

  private stop(item: ImageItem): void {
    if (this.sending !== item.key) return;
    if (item.sent < item.bytes) this.controller?.abort();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (!this.alive()) return;
        const next = this.shown.find((item) => item.phase === "waiting");
        if (next === undefined || next.file === null) return;
        await this.send(next, next.file);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async send(item: ImageItem, file: File): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.sending = item.key;
    this.change(item.key, { phase: "sending" });
    try {
      const image = await this.ports.stage(item.projectId, file, {
        signal: controller.signal,
        onProgress: (sent) => {
          if (!controller.signal.aborted && this.held(item.key)) {
            this.change(item.key, { sent: Math.min(sent, file.size) });
          }
        },
      });
      if (!this.alive() || !this.held(item.key)) {
        void this.ports.remove(item.projectId, image.id);
        return;
      }
      this.change(item.key, {
        phase: "staged",
        id: image.id,
        sent: file.size,
      });
    } catch (error) {
      if (!this.alive() || !this.held(item.key)) return;
      const f = failure(error);
      const tries = (this.tries.get(item.key) ?? 0) + 1;
      if (
        f.status === 409 &&
        f.words === UPLOAD_RUNNING &&
        tries < ADMISSION_TRIES
      ) {
        this.tries.set(item.key, tries);
        this.change(item.key, { phase: "waiting", sent: 0 });
        await this.ports.wait(ADMISSION_WAIT_MS);
      } else {
        this.change(item.key, {
          phase: "refused",
          words: f.words,
          status: f.status,
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
