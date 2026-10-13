// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The access keys section's rules: the new key's draft and its checks,
// and the variable shown once with the key. A key's row is views/keys/,
// shared with the admin's user page.

import type { CreateAccessKeyRequest } from "../../../shared/api/profile.ts";
import type {
  AccessKey,
  AccessKeyDays,
  AccessKeyScope,
} from "../../../shared/contracts/access-key.ts";
import { plural } from "../../lib/format.ts";
import { nameProblem } from "../../lib/names.ts";
import { at, type Problem } from "../../lib/save.ts";

export type KeyReach = "all" | "picked";

export type KeyDraft = {
  name: string;
  scope: AccessKeyScope;
  reach: KeyReach;
  // the picks, sent only when reach is picked
  projectIds: string[];
  days: AccessKeyDays;
};

// read and write, since working an external task writes; the shortest
// life
export const NEW_KEY: KeyDraft = {
  name: "",
  scope: "write",
  reach: "all",
  projectIds: [],
  days: 30,
};

export const SCOPE_OPTIONS: { value: AccessKeyScope; label: string }[] = [
  { value: "read", label: "Read" },
  { value: "write", label: "Read and write" },
];

export const REACH_OPTIONS: { value: KeyReach; label: string }[] = [
  { value: "all", label: "Every project" },
  { value: "picked", label: "Picked projects" },
];

export const DAYS_OPTIONS: { value: AccessKeyDays; label: string }[] = [
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "365 days" },
];

export const scopeHint = (scope: AccessKeyScope): string =>
  scope === "read"
    ? "Reads knowledge, chats and tasks."
    : "Reads, edits knowledge, works tasks.";

export const reachHint = (reach: KeyReach): string =>
  reach === "all" ? "All you see, now and later." : "Only these.";

export const OFF_TEXT = "Access keys are off. An admin can turn them on.";
export const SHOWN_ONCE = "Copy the key now. It is not shown again.";

export const capLine = (limit: number): string =>
  `At most ${plural(limit, "access key")}, expired ones included. Revoke one to make another.`;

// the checks the server makes, pinned to the field to fix
export function keyProblem(
  draft: KeyDraft,
  keys: readonly AccessKey[],
): Problem | null {
  const name = draft.name.trim();
  const named = at("name", nameProblem(draft.name));
  if (named !== null) return named;
  if (keys.some((k) => k.name === name)) {
    return { error: "Another access key has this name", field: "name" };
  }
  if (draft.reach === "picked" && draft.projectIds.length === 0) {
    return { error: "Pick a project", field: "projectIds" };
  }
  return null;
}

export function createBody(draft: KeyDraft): CreateAccessKeyRequest {
  return {
    name: draft.name.trim(),
    scope: draft.scope,
    projectIds: draft.reach === "all" ? null : draft.projectIds,
    days: draft.days,
  };
}

// which field a server refusal names; the cap's words are the form's
export function keyFieldOf(message: string): string | undefined {
  const m = message.toLowerCase();
  if (m.startsWith("name") || m.includes("name is taken")) return "name";
  if (m.startsWith("scope")) return "scope";
  if (m.startsWith("days")) return "days";
  if (m.startsWith("projectids") || m === "no such project") {
    return "projectIds";
  }
  return undefined;
}

// every setup reads the key from this variable, so none holds the key
export const KEY_ENV = "ONECTX_ACCESS_KEY";

export const exportLine = (token: string): string =>
  `export ${KEY_ENV}="${token}"`;
