// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The access keys section's rules: the new key's draft and its checks,
// and the two setup snippets shown once with the key. A key's row is
// views/keys/, shared with the admin's user page.

import type { CreateAccessKeyRequest } from "../../../shared/api/profile.ts";
import type {
  AccessKey,
  AccessKeyDays,
  AccessKeyScope,
} from "../../../shared/contracts/access-key.ts";
import { plural } from "../../lib/format.ts";
import { at, type Problem } from "../../lib/save.ts";
import { fullNameProblem } from "./Profile.model.ts";

export type KeyReach = "all" | "picked";

export type KeyDraft = {
  name: string;
  scope: AccessKeyScope;
  reach: KeyReach;
  // the picks, sent only when reach is picked
  projectIds: string[];
  days: AccessKeyDays;
};

// the narrowest key, and the shortest life
export const NEW_KEY: KeyDraft = {
  name: "",
  scope: "read",
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
    ? "Lists projects and reads their knowledge, chats and runs."
    : "Also creates, edits, renames and deletes knowledge files.";

export const reachHint = (reach: KeyReach): string =>
  reach === "all"
    ? "Every project you see, now and later."
    : "Only these, while you still see them.";

export const SECTION_TEXT =
  "Let your own agents, such as Claude Code or Codex, reach your projects over MCP.";
export const OFF_TEXT = "Access keys are off. An admin can turn them on.";
export const MUST_CHANGE_TEXT = "Change your password first.";
export const SHOWN_ONCE = "Copy the key now. It is not shown again.";

export const capLine = (limit: number): string =>
  `At most ${plural(limit, "access key")}, expired ones included. Revoke one to make another.`;

// the checks the server makes, pinned to the field to fix
export function keyProblem(
  draft: KeyDraft,
  keys: readonly AccessKey[],
): Problem | null {
  const name = draft.name.trim();
  const named = at("name", fullNameProblem(draft.name));
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

export const mcpUrl = (origin: string): string => `${origin}/mcp`;

export const claudeLine = (origin: string, token: string): string =>
  `claude mcp add --transport http 1ctx "${mcpUrl(origin)}" --header "Authorization: Bearer ${token}"`;

export const CODEX_ENV = "ONECTX_ACCESS_KEY";

export const codexBlock = (origin: string): string =>
  [
    "[mcp_servers.1ctx]",
    `url = "${mcpUrl(origin)}"`,
    `bearer_token_env_var = "${CODEX_ENV}"`,
  ].join("\n");
