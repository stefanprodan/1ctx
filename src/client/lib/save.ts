// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a Save button goes through: idle until something changed, busy
// while the call runs, done for a moment after it, or the reason it
// failed until the next edit. One object per form, disposed with it, so
// a call that answers after the form is gone changes nothing.

import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";

export type Status = "idle" | "busy" | "done" | { error: string };

export const DONE_MS = 2000;

export class Save {
  readonly status = signal<Status>("idle");
  private timer: ReturnType<typeof setTimeout> | null = null;
  private live = true;

  constructor(
    private readonly call: () => Promise<void>,
    private readonly doneMs = DONE_MS,
  ) {}

  // an edit clears a stale reason, and cuts a Saved short so the button
  // wakes for the new change
  touch(): void {
    if (this.status.value === "busy") return;
    this.clear();
    this.status.value = "idle";
  }

  async run(problem: string | null): Promise<void> {
    if (this.status.value === "busy") return;
    if (problem) {
      this.status.value = { error: problem };
      return;
    }
    this.status.value = "busy";
    let failed: string | null = null;
    try {
      await this.call();
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }
    if (!this.live) return;
    if (failed !== null) {
      this.status.value = { error: failed };
      return;
    }
    this.status.value = "done";
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.status.value === "done") this.status.value = "idle";
    }, this.doneMs);
  }

  dispose(): void {
    this.live = false;
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

// one Save per form, gone with it
export function useSave(call: () => Promise<void>): Save {
  const ref = useRef<Save | null>(null);
  if (ref.current === null) ref.current = new Save(call);
  useEffect(() => () => ref.current?.dispose(), []);
  return ref.current;
}
