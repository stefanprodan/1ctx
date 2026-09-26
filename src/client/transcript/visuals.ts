// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  Message,
  OpenedFile,
  SessionDetail,
  VisualDraft,
} from "../../shared/contracts/session.ts";
import { isVisualFrame, type VisualFrame } from "../../shared/socket.ts";
import { baseName } from "../lib/tree.ts";
import type { ReplyNode } from "./rows.ts";
import { shortArg } from "./Tool.model.ts";

export const visualKey = (messageId: string, callIndex: number): string =>
  `${messageId}:${callIndex}`;

// a file open put on the page is keyed apart from a visualize call: one
// tool row can carry both, and the cache drops them with the row alike
export const fileKey = (messageId: string, index: number): string =>
  `file:${messageId}:${index}`;

export type VisualPreview = VisualDraft & {
  sendId: string;
  phase: "draft" | "waiting" | "failed";
  error?: string;
};
export type Previews = ReadonlyMap<string, VisualPreview>;

export function applyVisual(
  previews: Previews,
  frame: VisualFrame,
): { previews: Previews; gap: boolean } {
  if (!isVisualFrame(frame)) return { previews, gap: true };
  const key = visualKey(frame.messageId, frame.callIndex);
  const previous = previews.get(key);
  if (previous && previous.phase !== "draft") return { previews, gap: false };
  const html = previous?.html ?? "";
  if (frame.htmlAt > html.length) return { previews, gap: true };
  const next = new Map(previews);
  next.set(key, {
    messageId: frame.messageId,
    callIndex: frame.callIndex,
    sendId: frame.sendId,
    phase: "draft",
    title: frame.title ?? previous?.title,
    html: html + frame.html.slice(html.length - frame.htmlAt),
  });
  return { previews: next, gap: false };
}

export function snapshotVisuals(
  previews: Previews,
  detail: SessionDetail,
): Previews {
  const next = new Map(previews);
  for (const draft of detail.live?.drafts ?? []) {
    next.set(visualKey(draft.messageId, draft.callIndex), {
      ...draft,
      sendId: detail.live!.sendId,
      phase: "draft",
    });
  }
  return reconcileVisuals(next, detail);
}

export function reconcileVisuals(
  previews: Previews,
  detail: SessionDetail,
): Previews {
  const rows = new Map(detail.messages.map((row) => [row.id, row]));
  const next = new Map<string, VisualPreview>();
  for (const [key, preview] of previews) {
    const row = rows.get(preview.messageId);
    if (!row) continue;
    if (preview.phase !== "draft") {
      next.set(key, preview);
    } else if (row.toolCalls?.[preview.callIndex]) {
      // The mounted frame keeps its last paint while the accepted call runs.
      next.set(key, { ...preview, phase: "waiting", html: "" });
    } else if (
      row.status !== "streaming" ||
      (detail.send?.id === preview.sendId && detail.send.status !== "running")
    ) {
      next.set(key, {
        ...preview,
        phase: "failed",
        error: row.error ?? detail.send?.error ?? "stopped",
      });
    } else next.set(key, preview);
  }
  return next;
}

export type VisualCard = {
  key: string;
  messageId: string;
  callIndex: number;
  title: string;
  preview?: VisualPreview;
  result: Message | null;
  // a visualize call, or the file a bash call opened at that position
  source: { kind: "call" } | { kind: "file"; index: number };
};

// a Markdown or code file a bash call opened, drawn in the reply beside
// the visuals; its text is loaded under its own key
export type FileCard = {
  kind: "file";
  key: string;
  messageId: string;
  index: number;
  file: OpenedFile;
};

export const isFileCard = (card: VisualCard | FileCard): card is FileCard =>
  "kind" in card;

// what a turn draws, in call order: a call's own visual first, then the
// files that call opened, in the order open ran
export function visualCards(
  node: ReplyNode,
  previews: Previews,
): (VisualCard | FileCard)[] {
  const cards: (VisualCard | FileCard)[] = [];
  for (const round of node.work?.rounds ?? []) {
    const calls = round.calls;
    const indexes = new Set(calls.map((_, index) => index));
    for (const preview of previews.values()) {
      if (preview.messageId === round.message.id)
        indexes.add(preview.callIndex);
    }
    for (const index of [...indexes].sort((a, b) => a - b)) {
      const key = visualKey(round.message.id, index);
      const preview = previews.get(key);
      const call = calls[index];
      const result = call?.result ?? null;
      const visualize = call === undefined || call.call.name === "visualize";
      if (visualize && (preview !== undefined || result?.status === "done")) {
        cards.push({
          key,
          messageId: round.message.id,
          callIndex: index,
          title:
            (call
              ? shortArg("visualize", call.call.arguments)
              : preview?.title) || "Visual",
          preview,
          result,
          source: { kind: "call" },
        });
      }
      if (result === null) continue;
      // an exit 1 keeps its opens, so a failed row draws them too; a
      // stopped row carries none
      (result.files ?? []).forEach((file, position) => {
        const cardKey = fileKey(result.id, position);
        if (file.kind === "visual") {
          cards.push({
            key: cardKey,
            messageId: result.id,
            callIndex: position,
            title: file.title || baseName(file.path),
            result,
            source: { kind: "file", index: position },
          });
        } else {
          cards.push({
            kind: "file",
            key: cardKey,
            messageId: result.id,
            index: position,
            file,
          });
        }
      });
    }
  }
  return cards;
}
