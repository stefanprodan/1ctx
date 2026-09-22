// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";
import type {
  OpenedFileResponse,
  ToolResultResponse,
  ToolVisualResponse,
} from "../../shared/api/sessions.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import { says } from "../lib/format.ts";
import type { ToolResult } from "../transcript/Tool.model.ts";
import { fileKey, visualKey } from "../transcript/visuals.ts";
import { api } from "./api.ts";

export type StoredVisual =
  | { status: "loading" }
  | ({ status: "done" } & ToolVisualResponse)
  | { status: "failed"; error: string };

// a Markdown or code file a bash call opened, by its file key; an
// opened visual is held with the visuals, since the frame draws it
export type StoredFile =
  | { status: "loading" }
  | ({ status: "done" } & OpenedFileResponse)
  | { status: "failed"; error: string };

export const toolResults = signal<ReadonlyMap<string, ToolResult>>(new Map());
export const toolVisuals = signal<ReadonlyMap<string, StoredVisual>>(new Map());
export const openedFiles = signal<ReadonlyMap<string, StoredFile>>(new Map());
let detail: SessionDetail | null = null;
const requests = new Map<string, AbortController>();

export function resetValues(): void {
  for (const request of requests.values()) request.abort();
  requests.clear();
  detail = null;
  toolResults.value = new Map();
  toolVisuals.value = new Map();
  openedFiles.value = new Map();
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
    row.files?.forEach((_, index) => {
      keys.add(fileKey(row.id, index));
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
  openedFiles.value = new Map(
    [...openedFiles.value].filter(([key]) => keys.has(key)),
  );
}

// a card leaving the page gives up what it had not loaded, whether it
// was a visualize call or an opened file
export function cancelValue(key: string): void {
  requests.get(key)?.abort();
  requests.delete(key);
  if (toolVisuals.value.get(key)?.status === "loading") {
    const next = new Map(toolVisuals.value);
    next.delete(key);
    toolVisuals.value = next;
  }
  if (openedFiles.value.get(key)?.status === "loading") {
    const next = new Map(openedFiles.value);
    next.delete(key);
    openedFiles.value = next;
  }
}

export function cancelVisual(messageId: string, index: number): void {
  cancelValue(visualKey(messageId, index));
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

// one file a bash call opened, whole. A visual joins the visuals, so
// the frame draws it as a visualize call's; the rest is its own map
export async function loadOpened(
  messageId: string,
  index: number,
): Promise<void> {
  const key = fileKey(messageId, index);
  if (!detail || toolVisuals.value.has(key) || openedFiles.value.has(key))
    return;
  const row = detail.messages.find((row) => row.id === messageId);
  const file = row?.files?.[index];
  if (file === undefined) return;
  const request = new AbortController();
  requests.set(key, request);
  const visual = file.kind === "visual";
  if (visual) {
    toolVisuals.value = new Map(toolVisuals.value).set(key, {
      status: "loading",
    });
  } else {
    openedFiles.value = new Map(openedFiles.value).set(key, {
      status: "loading",
    });
  }
  const fail = (error: string) => {
    if (requests.get(key) !== request) return;
    requests.delete(key);
    if (visual) {
      toolVisuals.value = new Map(toolVisuals.value).set(key, {
        status: "failed",
        error,
      });
    } else {
      openedFiles.value = new Map(openedFiles.value).set(key, {
        status: "failed",
        error,
      });
    }
  };
  try {
    const body = await api<OpenedFileResponse>(
      `/api/sessions/${encodeURIComponent(detail.session.id)}/messages/${encodeURIComponent(messageId)}/files/${index}`,
      "GET",
      undefined,
      request.signal,
    );
    if (requests.get(key) !== request) return;
    requests.delete(key);
    if (visual) {
      toolVisuals.value = new Map(toolVisuals.value).set(key, {
        status: "done",
        title: body.title || file.path.split("/").pop() || file.path,
        html: body.html,
      });
    } else {
      openedFiles.value = new Map(openedFiles.value).set(key, {
        status: "done",
        ...body,
      });
    }
  } catch (error) {
    if (!request.signal.aborted) fail(says(error));
  }
}
