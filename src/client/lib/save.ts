// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal, useSignal } from "@preact/signals";
import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { failure, says, sentence } from "./format.ts";
import { touch } from "./touch.ts";

export type Problem = {
  error: string;
  field?: string;
  action?: string;
  status?: number;
};

export type Status = "idle" | "busy" | "done" | Problem;

export type FieldOf = (message: string) => string | undefined;

export function at(field: string, error: string | null): Problem | null {
  return error === null ? null : { error, field };
}

export function noticeOf(problem: Problem): string {
  const why = sentence(problem.error);
  return problem.action === undefined
    ? why
    : `Could not ${problem.action}. ${why}`;
}

const DONE_MS = 2000;

export class Save {
  readonly status = signal<Status>("idle");
  readonly pending = signal<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private live = true;

  constructor(
    private readonly call: () => Promise<void>,
    private readonly doneMs = DONE_MS,
    private readonly fieldOf: FieldOf = () => undefined,
  ) {}

  get busy(): boolean {
    return this.status.value === "busy" || this.pending.value !== null;
  }

  fieldError(field: string): string | null {
    const status = this.status.value;
    return typeof status === "object" && status.field === field
      ? sentence(status.error)
      : null;
  }

  notice(): Problem | null {
    const status = this.status.value;
    return typeof status === "object" && status.field === undefined
      ? status
      : null;
  }

  // cuts a Saved short, so the button wakes for the new change
  touch(): void {
    if (this.busy) return;
    this.clear();
    this.status.value = "idle";
  }

  async run(problem: string | Problem | null): Promise<void> {
    if (this.busy) return;
    if (typeof problem === "string" && problem !== "") {
      this.status.value = { error: problem };
      return;
    }
    if (typeof problem === "object" && problem !== null) {
      this.status.value = problem;
      return;
    }
    this.clear();
    this.status.value = "busy";
    const failed = await this.attempt(this.call);
    if (!this.live) return;
    if (failed !== null) {
      this.status.value = failed;
      return;
    }
    this.status.value = "done";
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.status.value === "done") this.status.value = "idle";
    }, this.doneMs);
  }

  async act(action: string, call: () => Promise<unknown>): Promise<boolean> {
    if (this.busy) return false;
    this.clear();
    this.status.value = "idle";
    this.pending.value = action;
    const failed = await this.attempt(call);
    if (!this.live) return false;
    this.pending.value = null;
    if (failed !== null) {
      this.status.value = { ...failed, action };
      return false;
    }
    return true;
  }

  bind = (s: { value: string }) => (e: Event) => {
    s.value = (e.currentTarget as HTMLInputElement).value;
    this.touch();
  };

  dispose(): void {
    this.live = false;
    this.clear();
  }

  private async attempt(call: () => Promise<unknown>): Promise<Problem | null> {
    try {
      await call();
      return null;
    } catch (err) {
      const { words: error, status } = failure(err);
      const field = this.fieldOf(error);
      return {
        error,
        ...(field === undefined ? {} : { field }),
        ...(status === null ? {} : { status }),
      };
    }
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

// disposed with the form, so a call that answers after it is gone
// changes nothing
export function useSave(call: () => Promise<void>, fieldOf?: FieldOf): Save {
  const ref = useRef<Save | null>(null);
  if (ref.current === null) ref.current = new Save(call, DONE_MS, fieldOf);
  useEffect(() => () => ref.current?.dispose(), []);
  return ref.current;
}

export function useAction() {
  const busy = useSignal(false);
  const failed = useSignal<string | null>(null);
  const run = async (call: () => Promise<unknown>) => {
    busy.value = true;
    failed.value = null;
    try {
      await call();
    } catch (err) {
      failed.value = says(err);
    }
    busy.value = false;
  };
  return { busy, failure: failed, run };
}

export function useFocusField(
  save: Pick<Save, "status" | "busy">,
  form: RefObject<HTMLElement | null>,
): void {
  const status = save.status.value;
  const busy = save.busy;
  const field = typeof status === "object" ? status.field : undefined;
  useEffect(() => {
    if (busy || field === undefined) return;
    form.current
      ?.querySelector<HTMLElement>(`[name="${CSS.escape(field)}"]`)
      ?.focus();
  }, [status, busy]);
}

// on a touch screen nothing takes the focus, so the keyboard stays down
export function useArrivalFocus(
  form: RefObject<HTMLElement | null>,
  name: string,
): void {
  useEffect(() => {
    if (touch()) return;
    form.current
      ?.querySelector<HTMLElement>(`[name="${CSS.escape(name)}"]`)
      ?.focus();
  }, []);
}
