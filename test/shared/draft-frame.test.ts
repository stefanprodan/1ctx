// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  type DraftFrame,
  hasWatchedDrafts,
  isDraftFrame,
} from "../../src/shared/socket.ts";
import { pendingDraft } from "../fixtures/automations/draft-frame.ts";

const frame = {
  type: "draft",
  sessionId: "chat",
  draft: pendingDraft,
} satisfies DraftFrame;
const removed = {
  type: "draft",
  sessionId: "chat",
  draftId: "draft",
  removed: true,
} satisfies DraftFrame;

test("draft frames carry the whole draft in every state, or its removal", () => {
  for (const state of [
    "pending",
    "confirmed",
    "dismissed",
    "stale",
    "expired",
  ] as const) {
    expect(isDraftFrame({ ...frame, draft: { ...pendingDraft, state } })).toBe(
      true,
    );
    expect(
      isDraftFrame({
        ...frame,
        draft: {
          ...pendingDraft,
          state,
          decidedBy: { id: "user", username: "casey" },
          decidedAt: 100,
          createdAutomationId: "task",
          runSessionId: "run",
        },
      }),
    ).toBe(true);
  }
  expect(isDraftFrame(removed)).toBe(true);
  for (const action of ["update", "suspend", "resume", "run"] as const) {
    expect(
      isDraftFrame({
        ...frame,
        draft: {
          ...pendingDraft,
          action,
          automationId: "task",
          fields: action === "update" ? { once: true } : {},
        },
      }),
    ).toBe(true);
  }
});

test("draft frames reject malformed envelopes and nested drafts", () => {
  for (const value of [
    null,
    [],
    "",
    1,
    {},
    { ...frame, extra: true },
    { ...frame, draftId: "draft" },
    { ...frame, removed: true },
    { ...removed, removed: false },
    { ...removed, draft: pendingDraft },
    { ...removed, state: "removed" },
    { ...removed, draftId: "" },
    { ...removed, sessionId: "" },
  ]) {
    expect(isDraftFrame(value)).toBe(false);
  }
  for (const valid of [frame, removed]) {
    for (const key of Object.keys(valid)) {
      const missing = { ...valid } as Record<string, unknown>;
      delete missing[key];
      expect(isDraftFrame(missing)).toBe(false);
    }
  }
  for (const key of Object.keys(pendingDraft)) {
    const missing = { ...pendingDraft } as Record<string, unknown>;
    delete missing[key];
    expect(isDraftFrame({ ...frame, draft: missing })).toBe(false);
  }
  for (const draft of [
    null,
    [],
    "",
    {},
    { ...pendingDraft, extra: true },
    { ...pendingDraft, state: "removed" },
  ]) {
    expect(isDraftFrame({ ...frame, draft })).toBe(false);
  }
  for (const key of [
    "id",
    "sendId",
    "messageId",
    "agentId",
    "automationId",
    "createdAutomationId",
    "runSessionId",
  ]) {
    for (const value of ["", 1, undefined])
      expect(
        isDraftFrame({ ...frame, draft: { ...pendingDraft, [key]: value } }),
      ).toBe(false);
  }
  for (const by of [
    {},
    [],
    "user",
    { id: "", username: "casey" },
    { id: "user", username: "" },
    { id: "user", username: "casey", extra: true },
  ]) {
    for (const key of ["askedBy", "decidedBy"]) {
      expect(
        isDraftFrame({ ...frame, draft: { ...pendingDraft, [key]: by } }),
      ).toBe(false);
    }
  }
  for (const at of [
    -1,
    1.5,
    Infinity,
    NaN,
    "now",
    undefined,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    for (const key of ["decidedAt", "createdAt", "expiresAt"]) {
      expect(
        isDraftFrame({ ...frame, draft: { ...pendingDraft, [key]: at } }),
      ).toBe(false);
    }
  }
});

test("draft frames validate every proposal field and reject foreign fields", () => {
  for (const [key, value] of Object.entries(pendingDraft.fields)) {
    const fields = { ...pendingDraft.fields } as Record<string, unknown>;
    delete fields[key];
    expect(isDraftFrame({ ...frame, draft: { ...pendingDraft, fields } })).toBe(
      false,
    );
    fields[key] = typeof value === "string" ? false : "wrong";
    expect(isDraftFrame({ ...frame, draft: { ...pendingDraft, fields } })).toBe(
      false,
    );
  }
  for (const fields of [
    null,
    [],
    {},
    { ...pendingDraft.fields, extra: true },
    { ...pendingDraft.fields, disabledCapabilities: [1] },
    { ...pendingDraft.fields, attentionMode: "other" },
  ]) {
    expect(isDraftFrame({ ...frame, draft: { ...pendingDraft, fields } })).toBe(
      false,
    );
  }
  for (const [action, fields] of [
    ["update", {}],
    ["update", { once: "true" }],
    ["update", { agentId: "agent" }],
    ["run", { once: true }],
    ["other", {}],
  ]) {
    expect(
      isDraftFrame({ ...frame, draft: { ...pendingDraft, action, fields } }),
    ).toBe(false);
  }
});

test("a watched answer's drafts are whole drafts when present", () => {
  const watched = { type: "watched", sessionId: "chat", live: null };
  expect(hasWatchedDrafts(watched)).toBe(true);
  expect(hasWatchedDrafts({ ...watched, drafts: [pendingDraft] })).toBe(true);
  expect(hasWatchedDrafts({ ...watched, drafts: [] })).toBe(true);
  expect(hasWatchedDrafts({ ...watched, drafts: pendingDraft })).toBe(false);
  expect(
    hasWatchedDrafts({ ...watched, drafts: [{ ...pendingDraft, id: "" }] }),
  ).toBe(false);
});
