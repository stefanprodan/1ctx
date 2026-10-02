// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  CreateCredentialRequest,
  CredentialKey,
  PatchCredentialRequest,
} from "../../../shared/api/credentials.ts";
import {
  type CredentialSummary,
  DEFAULT_METHODS,
  HTTP_METHODS,
  type HttpMethod,
  type KeyState,
} from "../../../shared/contracts/credential.ts";
import { pluralCommas } from "../../lib/format.ts";
import { configCredentialHref } from "../../lib/hrefs.ts";
import { sameIds } from "../../lib/ids.ts";
import type { Option } from "../../ui/Select.model.ts";

export type CredentialDraft = {
  name: string;
  keyName: string;
  prefix: string;
  header: string;
  template: string;
  methods: HttpMethod[];
  projectIds: string[];
};

export const HEADER_PLACEHOLDER = "Authorization";
export const TEMPLATE_PLACEHOLDER = "Bearer {key}";
export const WEB_OFF_NOTE =
  "Web access is off. No credential is used until it is on.";

export function draftOf(c: CredentialSummary | null): CredentialDraft {
  if (c === null) {
    return {
      name: "",
      keyName: "",
      prefix: "",
      header: "",
      template: "",
      methods: [...DEFAULT_METHODS],
      projectIds: [],
    };
  }
  return {
    name: c.name,
    keyName: c.keyName,
    prefix: c.prefix,
    header: c.header,
    template: c.template,
    methods: [...c.methods],
    projectIds: c.projects.map((p) => p.id),
  };
}

// a name whose file is gone stays, marked, so the form says why the
// credential stopped signing
export function keyOptions(
  keys: readonly CredentialKey[],
  current: string,
): Option[] {
  const options: Option[] = keys.map((key) =>
    key.usable
      ? { value: key.name, label: key.name }
      : { value: key.name, label: key.name, detail: "unusable" },
  );
  if (current !== "" && !keys.some((key) => key.name === current)) {
    options.push({ value: current, label: current, detail: "missing" });
  }
  return options;
}

export function keyLine(
  keyName: string,
  state: KeyState,
): { text: string; bad: boolean } {
  if (state === "ok") return { text: `${keyName}.key`, bad: false };
  return { text: `${keyName}.key ${state}`, bad: true };
}

export function projectsLine(c: Pick<CredentialSummary, "projects">): string {
  return c.projects.length === 0
    ? "no projects"
    : c.projects.map((p) => p.name).join(", ");
}

export function toggledMethod(
  methods: readonly HttpMethod[],
  method: HttpMethod,
): HttpMethod[] {
  const next = methods.includes(method)
    ? methods.filter((m) => m !== method)
    : [...methods, method];
  return HTTP_METHODS.filter((m) => next.includes(m));
}

export type CredentialField =
  | "name"
  | "keyName"
  | "prefix"
  | "header"
  | "template"
  | "methods"
  | "projectIds";

export function credentialFieldOf(
  message: string,
): CredentialField | undefined {
  if (message.startsWith("name") || message.startsWith("a credential named")) {
    return "name";
  }
  for (const field of [
    "keyName",
    "prefix",
    "header",
    "template",
    "methods",
    "projectIds",
  ] as const) {
    if (message.startsWith(field)) return field;
  }
  if (message.startsWith("the prefix overlaps")) return "prefix";
  if (
    message.startsWith("no such team project") ||
    / has \d+ credentials$/.test(message)
  ) {
    return "projectIds";
  }
  return undefined;
}

export function problemOf(
  d: CredentialDraft,
  isNew: boolean,
): { error: string; field: CredentialField } | null {
  if (isNew && d.name.trim() === "") {
    return { error: "A name is required", field: "name" };
  }
  if (d.keyName === "") return { error: "Pick a key", field: "keyName" };
  if (d.prefix.trim() === "") {
    return { error: "A URL prefix is required", field: "prefix" };
  }
  if (d.header.trim() === "") {
    return { error: "A header is required", field: "header" };
  }
  if (d.template.trim() === "") {
    return { error: "A value is required", field: "template" };
  }
  if (d.methods.length === 0) {
    return { error: "Pick at least one method", field: "methods" };
  }
  return null;
}

export function createBody(d: CredentialDraft): CreateCredentialRequest {
  return {
    name: d.name.trim(),
    keyName: d.keyName,
    prefix: d.prefix.trim(),
    header: d.header.trim(),
    template: d.template.trim(),
    methods: d.methods,
    projectIds: d.projectIds,
  };
}

function patchBody(
  d: CredentialDraft,
  c: CredentialSummary,
): PatchCredentialRequest {
  const body: PatchCredentialRequest = {};
  if (d.keyName !== c.keyName) body.keyName = d.keyName;
  // the server keeps a value as given, so a row may hold spaces round it
  if (d.prefix.trim() !== c.prefix.trim()) body.prefix = d.prefix.trim();
  if (d.header.trim() !== c.header.trim()) body.header = d.header.trim();
  if (d.template.trim() !== c.template.trim()) {
    body.template = d.template.trim();
  }
  if (!sameIds(d.methods, c.methods)) body.methods = d.methods;
  const ids = c.projects.map((p) => p.id);
  if (!sameIds(d.projectIds, ids)) body.projectIds = d.projectIds;
  return body;
}

export function keyHint(
  keyName: string,
  c: Pick<CredentialSummary, "keyName" | "key"> | null,
): string | null {
  if (c === null || c.keyName !== keyName) return null;
  return c.key === "ok"
    ? `${c.keyName}.key is present`
    : `${c.keyName}.key is ${c.key}`;
}

// a project the list lacks stays in view, to be taken off
export function teamsOf(
  projects: readonly { id: string; name: string; kind: string }[],
  c: Pick<CredentialSummary, "projects"> | null,
): { id: string; name: string }[] {
  const teams = projects
    .filter((p) => p.kind === "team")
    .map((p) => ({ id: p.id, name: p.name }));
  const extra = (c?.projects ?? []).filter(
    (p) => !teams.some((q) => q.id === p.id),
  );
  return [...teams, ...extra].sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteLine(c: Pick<CredentialSummary, "prefix">): string {
  return `curl stops adding the header to requests under ${c.prefix}.`;
}

export function cardBody(
  d: CredentialDraft,
  c: CredentialSummary,
  keys: readonly CredentialField[],
): PatchCredentialRequest {
  const body = patchBody(d, c) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(body).filter(([key]) =>
      keys.includes(key as CredentialField),
    ),
  ) as PatchCredentialRequest;
}

export function cardProblem(
  d: CredentialDraft,
  keys: readonly CredentialField[],
): { error: string; field: CredentialField } | null {
  const problem = problemOf(d, false);
  return problem !== null && keys.includes(problem.field) ? problem : null;
}

// an overlap refused on Projects names the prefix, another card's field:
// it is this card's notice
export function cardFieldOf(
  keys: readonly CredentialField[],
): (message: string) => CredentialField | undefined {
  return (message) => {
    const field = credentialFieldOf(message);
    return field !== undefined && keys.includes(field) ? field : undefined;
  };
}

// a key is used by its credentials and by the repositories that read
// it without one
export function keyReader(
  list: readonly Pick<CredentialSummary, "name" | "keyName">[],
  keys: readonly CredentialKey[],
): (file: string) => { label: string; href?: string; quiet?: boolean } {
  return (file) => {
    const users = list.filter((c) => c.keyName === file);
    const repos = keys.find((key) => key.name === file)?.repos ?? [];
    if (users.length + repos.length === 0) {
      return { label: "unused", quiet: true };
    }
    if (users.length === 1 && repos.length === 0) {
      const name = users[0]!.name;
      return { label: name, href: configCredentialHref(name) };
    }
    if (users.length === 0 && repos.length === 1) return { label: repos[0]! };
    const parts = [
      users.length > 0 &&
        pluralCommas(users.length, "credential", "credentials"),
      repos.length > 0 &&
        pluralCommas(repos.length, "repository", "repositories"),
    ];
    return { label: parts.filter((part) => part !== false).join(", ") };
  };
}
