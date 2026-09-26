// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The uploader's state, apart from its view so every path is tested
// without a DOM: what was picked and how each item was judged by the
// server's own rules, then one run sending the items one at a time,
// each ending in exactly one outcome. The words are Upload.words.ts.

import { signal } from "@preact/signals";
import type { KnowledgeUploadResult } from "../../../shared/contracts/knowledge.ts";
import {
  isFolderRefusal,
  isLeftOut,
  knowledgeFolder,
  normalizeKnowledgePath,
} from "../../../shared/knowledge.ts";
import { failure, sentence } from "../../lib/format.ts";
import { judgePick, type PickKind, type PickSkip } from "../../lib/pick.ts";
import type { Problem, Status } from "../../lib/save.ts";

export const UPLOAD_BYTES = 32 * 1024 * 1024;
type Kind = PickKind;
export type Skip = PickSkip;
type Outcome =
  | { type: "written" | "unchanged"; result: KnowledgeUploadResult }
  | { type: "skipped"; reason: Skip }
  | { type: "failed"; problem: Problem }
  | { type: "not-sent" }
  | { type: "uncertain" };
export type UploadItem = {
  file: File;
  kind: Kind;
  invalid: Skip | null;
  name: string;
  phase: "picked" | "waiting" | "sending" | "saving" | "done";
  sent: number;
  outcome: Outcome | null;
};
export type UploadPorts = {
  upload(
    file: File,
    folder: string,
    options: {
      signal: AbortSignal;
      onProgress: (sent: number, total: number) => void;
    },
  ): Promise<KnowledgeUploadResult>;
  reload(): Promise<void>;
  currentUser(): string | null;
  rules(): { fileBytes: number; names: readonly string[] };
};
function folderName(raw: string): string | null {
  const folder = knowledgeFolder(raw);
  return folder.ok ? folder.name : null;
}
function judge(
  item: UploadItem,
  folder: string,
  rules: ReturnType<UploadPorts["rules"]>,
): UploadItem {
  let invalid = item.invalid;
  let name = item.file.name;
  if (invalid !== "upload-size" && item.kind === "text") {
    const normalized = normalizeKnowledgePath(name);
    if (!normalized.ok) invalid = normalized.reason;
    else {
      const joined = normalizeKnowledgePath(
        [folderName(folder), normalized.name].filter(Boolean).join("/"),
      );
      if (!joined.ok) invalid = joined.reason;
      else {
        name = joined.name;
        if (item.file.size > rules.fileBytes && !rules.names.includes(name))
          invalid = "too-big";
      }
    }
  }
  return {
    ...item,
    name,
    outcome: invalid ? { type: "skipped", reason: invalid } : null,
  };
}

export class UploadState {
  readonly items = signal<UploadItem[]>([]);
  readonly folder = signal("");
  readonly phase = signal<"empty" | "picked" | "uploading" | "done">("empty");
  readonly status = signal<Status>("idle");
  readonly reading = signal(false);
  readonly stopped = signal(false);
  readonly folderRefused = signal(false);
  private live = true;
  private controller: AbortController | null = null;
  private readonly user: string | null;

  constructor(private readonly ports: UploadPorts) {
    this.user = ports.currentUser();
  }
  get busy(): boolean {
    return this.reading.value || this.phase.value === "uploading";
  }
  get ready(): UploadItem[] {
    return this.items.value.filter((item) => item.outcome?.type !== "skipped");
  }
  fieldError(field: string): string | null {
    const p = this.status.value;
    return typeof p === "object" && p.field === field
      ? sentence(p.error)
      : null;
  }
  notice(): Problem | null {
    const p = this.status.value;
    return typeof p === "object" && !p.field ? p : null;
  }
  setFolder(value: string): void {
    if (this.busy) return;
    this.folder.value = value;
    this.status.value = "idle";
    if (this.phase.value === "done") return;
    this.items.value = this.items.value.map((item) =>
      judge(item, value, this.ports.rules()),
    );
  }
  async pick(files: readonly File[]): Promise<void> {
    if (this.busy || this.phase.value === "done" || !this.live) return;
    this.reading.value = true;
    this.status.value = "idle";
    try {
      for (const file of files) {
        // a dragged folder brings Finder's .DS_Store or a .git; neither
        // joins the list
        if (isLeftOut(file.name)) continue;
        if (
          this.items.value.some(
            (item) =>
              item.file.name === file.name &&
              item.file.size === file.size &&
              item.file.lastModified === file.lastModified,
          )
        )
          continue;
        const { kind, invalid } = await judgePick(file, {
          itemBytes: UPLOAD_BYTES,
          fileBytes: this.ports.rules().fileBytes,
        });
        if (!this.live || this.ports.currentUser() !== this.user) return;
        const item: UploadItem = {
          file,
          kind,
          invalid,
          name: file.name,
          sent: 0,
          phase: "picked",
          outcome: null,
        };
        this.items.value = [
          ...this.items.value,
          judge(item, this.folder.value, this.ports.rules()),
        ];
        this.phase.value = "picked";
      }
    } catch (error) {
      if (this.live) this.status.value = problem(error, "read the picked file");
    } finally {
      this.reading.value = false;
    }
  }
  remove(file: File): void {
    if (this.busy || this.phase.value === "done") return;
    this.items.value = this.items.value.filter((item) => item.file !== file);
    if (!this.items.value.length) this.phase.value = "empty";
  }
  reset(): void {
    if (this.busy) return;
    this.items.value = [];
    this.phase.value = "empty";
    this.status.value = "idle";
    this.stopped.value = false;
    this.folderRefused.value = false;
  }
  userChanged(): void {
    if (this.ports.currentUser() !== this.user) this.dispose();
  }
  dispose(): void {
    this.live = false;
    this.stop();
  }
  stop(): void {
    if (this.phase.value !== "uploading") return;
    this.stopped.value = true;
    this.controller?.abort();
  }
  private change(file: File, patch: Partial<UploadItem>): void {
    this.items.value = this.items.value.map((item) =>
      item.file === file ? { ...item, ...patch } : item,
    );
  }
  async run(): Promise<void> {
    if (
      this.busy ||
      !this.live ||
      this.phase.value !== "picked" ||
      !this.ready.length
    )
      return;
    if (this.ports.currentUser() !== this.user) {
      this.dispose();
      return;
    }
    const checked = knowledgeFolder(this.folder.value);
    if (!checked.ok) {
      this.folderRefused.value = true;
      this.status.value = { field: "folder", error: checked.words };
      return;
    }
    this.items.value = this.items.value.map((item) =>
      judge(item, this.folder.value, this.ports.rules()),
    );
    if (!this.ready.length) return;
    const folder = this.folder.value;
    this.folderRefused.value = false;
    const queue = this.ready;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.stopped.value = false;
    this.status.value = "idle";
    this.items.value = this.items.value.map((item) => ({
      ...item,
      phase: item.outcome ? "done" : "waiting",
    }));
    this.phase.value = "uploading";
    try {
      for (const item of queue) {
        this.userChanged();
        if (signal.aborted) break;
        this.change(item.file, { phase: "sending" });
        try {
          const result = await this.ports.upload(item.file, folder, {
            signal,
            onProgress: (sent) => {
              if (signal.aborted) return;
              this.change(item.file, {
                sent: Math.min(sent, item.file.size),
                phase: sent >= item.file.size ? "saving" : "sending",
              });
            },
          });
          this.change(item.file, {
            sent: item.file.size,
            phase: "done",
            outcome: {
              type:
                result.added + result.replaced > 0 ? "written" : "unchanged",
              result,
            },
          });
        } catch (error) {
          const p = problem(error);
          const field = isFolderRefusal(p.error) ? "folder" : undefined;
          if (p.status === 401 || field || !signal.aborted) {
            this.change(item.file, {
              phase: "done",
              outcome: { type: "failed", problem: { ...p, field } },
            });
            if (field) {
              this.folderRefused.value = true;
              this.status.value = { ...p, field };
            }
            if (field || p.status === 401) this.stop();
          } else {
            const sent = this.items.value.find(
              (row) => row.file === item.file,
            )!.sent;
            this.change(item.file, {
              phase: "done",
              outcome: {
                type: sent >= item.file.size ? "uncertain" : "not-sent",
              },
            });
          }
        }
      }
    } finally {
      this.items.value = this.items.value.map((item) =>
        item.outcome
          ? item
          : { ...item, phase: "done", outcome: { type: "not-sent" } },
      );
      // Never load the old project's rows into a different user's cache.
      if (this.ports.currentUser() === this.user) {
        try {
          await this.ports.reload();
        } catch (error) {
          this.status.value = problem(error, "reload the files");
        }
      }
      this.controller = null;
      this.phase.value = "done";
    }
  }
}

function problem(error: unknown, action?: string): Problem {
  const f = failure(error);
  return {
    error: f.words,
    ...(f.status === null ? {} : { status: f.status }),
    ...(action ? { action } : {}),
  };
}
