// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a form's buttons go through: idle until something changed, busy
// while a call runs, done for a moment after a save, or the refusal
// until the next edit. The submit and the other actions of the form
// (delete, disable, reset) share one object, so while any of them runs
// every button waits, and one refusal is shown at a time. A refusal that
// names a field is shown at that field; any other is the form's notice
// in the foot, naming the action that failed. One object per form,
// disposed with it, so a call that answers after the form is gone
// changes nothing.

import { signal } from "@preact/signals";
import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { failure } from "./format.ts";

// the words of a refusal; the field to blame, when there is one; the
// action other than the submit that was refused; and the HTTP status
// when the server answered with one
export type Problem = {
  error: string;
  field?: string;
  action?: string;
  status?: number;
};

export type Status = "idle" | "busy" | "done" | Problem;

// which field a server refusal is about, from its words; undefined
// when it is about the form as a whole
export type FieldOf = (message: string) => string | undefined;

// a check's words pinned to its field, or null when the check passed
export function at(field: string, error: string | null): Problem | null {
  return error === null ? null : { error, field };
}

// the server speaks in lowercase fragments; the page shows sentences
export function sentence(text: string): string {
  const t = text.trim();
  if (t === "") return t;
  const upper = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(upper) ? upper : `${upper}.`;
}

// the notice's words: the action that failed, then why
export function noticeOf(problem: Problem): string {
  const why = sentence(problem.error);
  return problem.action === undefined
    ? why
    : `Could not ${problem.action}. ${why}`;
}

export const DONE_MS = 2000;

export class Save {
  readonly status = signal<Status>("idle");
  // the action other than the submit that is running, for its label
  readonly pending = signal<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private live = true;

  constructor(
    private readonly call: () => Promise<void>,
    private readonly doneMs = DONE_MS,
    private readonly fieldOf: FieldOf = () => undefined,
  ) {}

  // any call of the form in flight
  get busy(): boolean {
    return this.status.value === "busy" || this.pending.value !== null;
  }

  // the refusal to show at a field, or null
  fieldError(field: string): string | null {
    const status = this.status.value;
    return typeof status === "object" && status.field === field
      ? sentence(status.error)
      : null;
  }

  // the refusal about the form as a whole, or null
  notice(): Problem | null {
    const status = this.status.value;
    return typeof status === "object" && status.field === undefined
      ? status
      : null;
  }

  // an edit clears a stale reason, and cuts a Saved short so the button
  // wakes for the new change
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

  // another button of the form: "delete", "disable", named as the notice
  // says it ("Could not delete."). Answers whether the call went through,
  // so the form can close after a delete.
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

// one Save per form, gone with it
export function useSave(call: () => Promise<void>, fieldOf?: FieldOf): Save {
  const ref = useRef<Save | null>(null);
  if (ref.current === null) ref.current = new Save(call, DONE_MS, fieldOf);
  useEffect(() => () => ref.current?.dispose(), []);
  return ref.current;
}

// a refusal at a field takes the focus there, so the fix is one keystroke
// away; the control carries the field's name
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
