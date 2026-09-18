// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";
import type {
  ToolResultResponse,
  ToolVisualResponse,
} from "../../shared/api/sessions.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import { says } from "../lib/format.ts";
import type { ToolResult } from "../transcript/Tool.model.ts";
import { visualKey } from "../transcript/visuals.ts";
import { api } from "./api.ts";

export type StoredVisual =
  | { status: "loading" }
  | ({ status: "done" } & ToolVisualResponse)
  | { status: "failed"; error: string };

export const toolResults = signal<ReadonlyMap<string, ToolResult>>(new Map());
export const toolVisuals = signal<ReadonlyMap<string, StoredVisual>>(new Map());
let detail: SessionDetail | null = null;
const requests = new Map<string, AbortController>();

export function resetValues(): void {
  for (const request of requests.values()) request.abort();
  requests.clear();
  detail = null;
  toolResults.value = new Map();
  toolVisuals.value = new Map();
}

export function syncValues(next: SessionDetail): void {
  if (detail !== null && detail.session.id !== next.session.id) resetValues();
  detail = next;
  const keys = new Set<string>();
  for (const row of next.messages) {
    keys.add(row.id);
    row.toolCalls?.forEach((_, index) => {
      keys.add(visualKey(row.id, index));
    });
  }
  for (const [key, request] of requests) {
    if (!keys.has(key)) {
      request.abort();
      requests.delete(key);
    }
  }
  toolResults.value = new Map(
    [...toolResults.value].filter(([key]) => keys.has(key)),
  );
  toolVisuals.value = new Map(
    [...toolVisuals.value].filter(([key]) => keys.has(key)),
  );
}

export function cancelVisual(messageId: string, index: number): void {
  const key = visualKey(messageId, index);
  requests.get(key)?.abort();
  requests.delete(key);
  if (toolVisuals.value.get(key)?.status === "loading") {
    const next = new Map(toolVisuals.value);
    next.delete(key);
    toolVisuals.value = next;
  }
}

export async function loadToolResult(messageId: string): Promise<void> {
  if (!detail || toolResults.value.has(messageId)) return;
  const row = detail.messages.find((row) => row.id === messageId);
  if (row?.kind !== "tool" || row.status === "streaming") return;
  const request = new AbortController();
  requests.set(messageId, request);
  toolResults.value = new Map(toolResults.value).set(messageId, {
    status: "loading",
  });
  const set = (value: ToolResult) => {
    if (requests.get(messageId) !== request) return;
    requests.delete(messageId);
    toolResults.value = new Map(toolResults.value).set(messageId, value);
  };
  try {
    const body = await api<ToolResultResponse>(
      `/api/sessions/${encodeURIComponent(detail.session.id)}/messages/${encodeURIComponent(messageId)}/result`,
      "GET",
      undefined,
      request.signal,
    );
    set({ status: "done", ...body });
  } catch (error) {
    if (!request.signal.aborted) set({ status: "failed", error: says(error) });
  }
}

export async function loadVisual(
  messageId: string,
  index: number,
): Promise<void> {
  const key = visualKey(messageId, index);
  if (!detail || toolVisuals.value.has(key)) return;
  const row = detail.messages.find((row) => row.id === messageId);
  if (row?.toolCalls?.[index]?.name !== "visualize") return;
  const request = new AbortController();
  requests.set(key, request);
  toolVisuals.value = new Map(toolVisuals.value).set(key, {
    status: "loading",
  });
  const set = (value: StoredVisual) => {
    if (requests.get(key) !== request) return;
    requests.delete(key);
    toolVisuals.value = new Map(toolVisuals.value).set(key, value);
  };
  try {
    const body = await api<ToolVisualResponse>(
      `/api/sessions/${encodeURIComponent(detail.session.id)}/messages/${encodeURIComponent(messageId)}/calls/${index}/visual`,
      "GET",
      undefined,
      request.signal,
    );
    set({ status: "done", ...body });
  } catch (error) {
    if (!request.signal.aborted) set({ status: "failed", error: says(error) });
  }
}
