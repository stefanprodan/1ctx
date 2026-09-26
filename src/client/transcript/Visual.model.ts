// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { VISUAL_FRAME_BYTES } from "../../shared/words.ts";

export const PAINT_MS = 150;
export const THEME_TOKENS = [
  "--fg",
  "--dim",
  "--faint",
  "--card",
  "--inset",
  "--page",
  "--line",
  "--line-strong",
  "--radius",
  "--radius-card",
  "--sans",
  "--serif",
  "--mono",
] as const;

export type VisualTheme = {
  type: "theme";
  scheme: "light" | "dark";
  values: Record<string, string>;
};
export type VisualPost =
  | VisualTheme
  | { type: "paint" | "final"; html: string };
export type VisualState =
  | "loading"
  | "ready"
  | "painting"
  | "finalizing"
  | "finalized"
  | "failed"
  | "navigated";
export type VisualStatus = {
  state: VisualState;
  height: number;
  error: string | null;
};
type Reply =
  | { type: "ready" | "finalized" }
  | { type: "height"; height: number }
  | { type: "error"; message: string };

export function visualReply(value: unknown): value is Reply {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("type" in value)) return false;
  const count = Object.keys(value).length;
  if (value.type === "ready" || value.type === "finalized") return count === 1;
  if (value.type === "height") {
    return (
      count === 2 &&
      "height" in value &&
      typeof value.height === "number" &&
      Number.isFinite(value.height)
    );
  }
  return (
    value.type === "error" &&
    count === 2 &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    value.message.length <= 240 &&
    !/[\r\n]/.test(value.message)
  );
}

// the frame accepts what the server and the open command check
const fits = (html: string): boolean =>
  html.length <= VISUAL_FRAME_BYTES &&
  new TextEncoder().encode(html).byteLength <= VISUAL_FRAME_BYTES;

const visualHeight = (height: number): number =>
  Math.min(2000, Math.max(80, Math.ceil(height)));

export function readTheme(
  scheme: string,
  read: (name: string) => string,
): VisualTheme {
  return {
    type: "theme",
    scheme: scheme.split(/\s+/).includes("dark") ? "dark" : "light",
    values: Object.fromEntries(
      THEME_TOKENS.map((name) => [name, read(name).trim()]),
    ),
  };
}

export class VisualPlayer {
  status: VisualStatus = { state: "loading", height: 80, error: null };
  private loaded = false;
  private ready = false;
  private closed = false;
  private final = false;
  private theme: VisualTheme | null = null;
  private pending: Extract<VisualPost, { html: string }> | null = null;
  private cancel: (() => void) | null = null;
  private lastPaint = -Infinity;

  constructor(
    private readonly io: {
      post(message: VisualPost): void;
      close(): void;
      now(): number;
      schedule(callback: () => void, ms: number): () => void;
      changed(status: VisualStatus): void;
    },
  ) {}

  private change(fields: Partial<VisualStatus>): void {
    this.status = { ...this.status, ...fields };
    this.io.changed(this.status);
  }

  load(): boolean {
    if (this.closed) return false;
    if (!this.loaded) {
      this.loaded = true;
      return true;
    }
    this.dispose();
    this.change({ state: "navigated", error: "the visual navigated away" });
    return false;
  }

  receive(value: unknown, fromPort: boolean): void {
    if (this.closed || !this.loaded || !fromPort || !visualReply(value)) return;
    if (value.type === "ready") {
      if (this.ready) return;
      this.ready = true;
      if (this.status.error === null) this.change({ state: "ready" });
      if (this.theme) this.io.post(this.theme);
      this.flush();
    } else if (!this.ready) {
      return;
    } else if (value.type === "height") {
      this.change({ height: visualHeight(value.height) });
    } else if (value.type === "error") {
      this.fail(this.status.error ?? value.message);
    } else if (this.final && this.status.error === null) {
      this.change({ state: "finalized" });
    }
  }

  setTheme(theme: VisualTheme): void {
    if (this.closed || JSON.stringify(theme) === JSON.stringify(this.theme))
      return;
    this.theme = theme;
    if (this.ready) {
      this.io.post(theme);
      this.flush();
    }
  }

  draw(html: string, final = false): void {
    if (this.closed || this.final || this.status.error !== null) return;
    if (!fits(html)) {
      this.fail("the visual is too large");
      return;
    }
    this.pending = { type: final ? "final" : "paint", html };
    if (final) {
      this.final = true;
      this.cancel?.();
      this.cancel = null;
    }
    this.flush();
  }

  wait(): void {
    this.cancel?.();
    this.cancel = null;
    this.pending = null;
  }

  fail(error: string, preview?: string): void {
    if (this.closed) return;
    this.wait();
    this.change({ state: "failed", error });
    if (preview !== undefined && !this.final && fits(preview)) {
      this.pending = { type: "paint", html: preview };
      this.flush();
    }
  }

  private flush(): void {
    if (this.closed || !this.ready || !this.theme || !this.pending) return;
    const wait =
      this.pending.type === "final"
        ? 0
        : Math.max(0, this.lastPaint + PAINT_MS - this.io.now());
    if (wait > 0) {
      if (!this.cancel) {
        this.cancel = this.io.schedule(() => {
          this.cancel = null;
          this.flush();
        }, wait);
      }
      return;
    }
    const message = this.pending;
    this.pending = null;
    this.lastPaint = this.io.now();
    if (this.status.error === null) {
      this.change({
        state: message.type === "final" ? "finalizing" : "painting",
      });
    }
    this.io.post(message);
  }

  dispose(): void {
    this.closed = true;
    this.wait();
    this.io.close();
  }
}
