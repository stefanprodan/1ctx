// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  Message,
  SessionDetail,
  VisualDraft,
} from "../../shared/contracts/session.ts";
import { isVisualFrame, type VisualFrame } from "../../shared/socket.ts";
import type { ReplyNode } from "./rows.ts";
import { shortArg } from "./Tool.model.ts";

export const visualKey = (messageId: string, callIndex: number): string =>
  `${messageId}:${callIndex}`;

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
};

export function visualCards(node: ReplyNode, previews: Previews): VisualCard[] {
  const cards: VisualCard[] = [];
  for (const round of node.work?.rounds ?? []) {
    const calls = round.calls;
    const indexes = new Set(
      calls.flatMap(({ call }, index) =>
        call.name === "visualize" ? [index] : [],
      ),
    );
    for (const preview of previews.values()) {
      if (preview.messageId === round.message.id)
        indexes.add(preview.callIndex);
    }
    for (const index of [...indexes].sort((a, b) => a - b)) {
      const key = visualKey(round.message.id, index);
      const preview = previews.get(key);
      const call = calls[index];
      const result = call?.result ?? null;
      if (!preview && result?.status !== "done") continue;
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
      });
    }
  }
  return cards;
}
