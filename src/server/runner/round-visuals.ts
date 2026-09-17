// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ChatEvent } from "../providers/index.ts";
import type { ActiveSend, RoundState } from "./send.ts";
import { VisualStream } from "./visual-stream.ts";
import type { Writer } from "./writer.ts";

export const VISUAL_EVERY_MS = 100;
export const VISUAL_EVERY_BYTES = 4096;

type DraftReader = {
  reader: VisualStream;
  name: string;
  streaming: boolean;
  htmlAt: number;
  title: string | undefined;
  pendingBytes: number;
};

export class RoundVisuals {
  private readonly readers = new Map<number, DraftReader>();
  private readonly pending = new Set<number>();
  private pendingAt: number | null = null;

  constructor(
    private readonly send: ActiveSend,
    private readonly round: RoundState,
    private readonly writer: Pick<Writer, "visual">,
    private readonly signal: AbortSignal,
  ) {}

  push(
    event: Extract<ChatEvent, { kind: "toolCallDelta" }>,
    now: number,
  ): void {
    if (this.signal.aborted || this.send.round !== this.round) return;
    const index = event.callIndex;
    if (index === undefined) {
      throw new Error("the provider omitted a tool call index");
    }
    let draft = this.readers.get(index);
    const name = event.name ?? draft?.name ?? "";
    if (name !== "" && name !== "visualize") {
      this.readers.delete(index);
      this.pending.delete(index);
      this.round.drafts.delete(index);
      return;
    }
    if (draft === undefined) {
      draft = {
        reader: new VisualStream(this.send.policy.toolCaps.visualBytes),
        name,
        streaming: false,
        htmlAt: 0,
        title: undefined,
        pendingBytes: 0,
      };
      this.readers.set(index, draft);
    }
    const before = draft.reader.html.length;
    draft.name = name;
    draft.reader.push(event.arguments ?? "");
    if (draft.reader.ended) {
      this.pending.delete(index);
      this.round.drafts.delete(index);
      return;
    }
    draft.pendingBytes += new TextEncoder().encode(
      draft.reader.html.slice(before),
    ).byteLength;
    // A whole argument value never creates a preview, even after an empty delta.
    if (
      !draft.reader.complete &&
      (draft.reader.html !== "" || draft.reader.title !== undefined)
    ) {
      draft.streaming = true;
    }
    if (
      name !== "visualize" ||
      !draft.streaming ||
      (draft.reader.html.length === draft.htmlAt &&
        draft.reader.title === draft.title)
    ) {
      return;
    }
    if (this.pending.size === 0) this.pendingAt = now;
    this.pending.add(index);
    if (draft.pendingBytes >= VISUAL_EVERY_BYTES) this.flush();
  }

  delay(now: number): number | null {
    return this.signal.aborted ||
      this.send.round !== this.round ||
      this.pending.size === 0 ||
      this.pendingAt === null
      ? null
      : Math.max(0, this.pendingAt + VISUAL_EVERY_MS - now);
  }

  flush(): void {
    if (this.signal.aborted || this.send.round !== this.round) return;
    for (const index of this.pending) {
      const draft = this.readers.get(index)!;
      const { reader } = draft;
      this.writer.visual(this.send, {
        callIndex: index,
        ...(reader.title === draft.title ? {} : { title: reader.title }),
        html: reader.html.slice(draft.htmlAt),
        htmlAt: draft.htmlAt,
      });
      draft.htmlAt = reader.html.length;
      draft.title = reader.title;
      draft.pendingBytes = 0;
    }
    this.pending.clear();
    this.pendingAt = null;
  }
}
