// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";
import type {
  OpenedFileResponse,
  ToolResultResponse,
  ToolVisualResponse,
} from "../../shared/api/sessions.ts";
import type {
  LiveRetry,
  LiveSend,
  SessionDetail,
} from "../../shared/contracts/session.ts";
import { says } from "../lib/format.ts";
import { baseName } from "../lib/tree.ts";
import type { ToolResult } from "../transcript/Tool.model.ts";
import { fileKey, visualKey } from "../transcript/visuals.ts";
import { api } from "./api.ts";
import {
  childRow,
  childRowIds,
  dropChildren,
  resetChildren,
} from "./session-children.ts";

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
// each send's round waiting to ask its provider again, by send id, from
// the snapshot and the retry frames; never stored
export const retries = signal<ReadonlyMap<string, LiveRetry>>(new Map());

export const retriesOf = (live: readonly LiveSend[]) =>
  new Map(
    live.flatMap((send) =>
      send.retry === undefined ? [] : [[send.sendId, send.retry] as const],
    ),
  );

// one send's retry frame: a null retry clears it
export function retried(sendId: string, retry: LiveRetry | null): void {
  const next = new Map(retries.value);
  if (retry === null) next.delete(sendId);
  else next.set(sendId, retry);
  retries.value = next;
}
let detail: SessionDetail | null = null;
const requests = new Map<string, AbortController>();

export function resetValues(): void {
  for (const request of requests.values()) request.abort();
  requests.clear();
  detail = null;
  resetChildren();
  toolResults.value = new Map();
  toolVisuals.value = new Map();
  openedFiles.value = new Map();
  retries.value = new Map();
}

// the sends a detail holds as aged
const sweptOf = (d: SessionDetail): Set<string> =>
  new Set(
    [...(d.sends ?? []), ...(d.send ? [d.send] : [])]
      .filter((send) => send.swept === true)
      .map((send) => send.id),
  );

export function syncValues(next: SessionDetail): void {
  if (detail !== null && detail.session.id !== next.session.id) resetValues();
  const before = detail === null ? null : sweptOf(detail);
  detail = next;
  // a turn that just aged lost its tool output and its subagents, so the
  // results and child work loaded before go with them; the ids stay
  const aged = new Set<string>();
  if (before !== null) {
    const swept = sweptOf(next);
    for (const row of next.messages) {
      if (swept.has(row.sendId) && !before.has(row.sendId)) aged.add(row.id);
    }
  }
  dropChildren(aged);
  // a subagent's rows keep their results while the chat is on screen
  const keys = new Set<string>(childRowIds());
  for (const row of next.messages) {
    if (!aged.has(row.id)) keys.add(row.id);
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
  const row =
    detail.messages.find((row) => row.id === messageId) ?? childRow(messageId);
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
        title: body.title || baseName(file.path),
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
