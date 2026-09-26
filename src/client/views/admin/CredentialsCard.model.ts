// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the Credentials card shows and checks without a DOM: the form's
// fields from a row or for a new one, the key picks with the files that
// cannot be used marked, the row's key line, the head's total, which
// field a refusal names, and the body a save sends.

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
export const TEMPLATE_HINT = "The key goes where {key} is";
export const PREFIX_HINT = "Requests under it are signed. Narrow is better";
export const CARD_NOTE =
  "curl in a chat of a bound project sends the header for URLs under the prefix. The key never reaches the chat.";

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

// the http- files to pick from, a file failing the key's rule marked; a
// name whose file is gone stays on the list, marked, so the form says
// why the credential stopped signing
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

// the key's part of a row's meta, and whether it is a failure
export function keyLine(
  keyName: string,
  state: KeyState,
): { text: string; bad: boolean } {
  if (state === "ok") return { text: `${keyName}.key`, bad: false };
  return { text: `${keyName}.key ${state}`, bad: true };
}

// the projects a row names, or that it has none
export function projectsLine(c: Pick<CredentialSummary, "projects">): string {
  return c.projects.length === 0
    ? "no projects"
    : c.projects.map((p) => p.name).join(", ");
}

export function totalLine(count: number): string {
  return count === 1 ? "1 credential" : `${count} credentials`;
}

// the methods in the server's order, the one picked flipped
export function toggledMethod(
  methods: readonly HttpMethod[],
  method: HttpMethod,
): HttpMethod[] {
  const next = methods.includes(method)
    ? methods.filter((m) => m !== method)
    : [...methods, method];
  return HTTP_METHODS.filter((m) => next.includes(m));
}

type CredentialField =
  | "name"
  | "keyName"
  | "prefix"
  | "header"
  | "template"
  | "methods"
  | "projectIds";

// which field a server refusal names; anything else is the form's
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

// the first empty field, as the form checks it before a call
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

// only what changed, so a save never replaces a list it did not touch
export function patchBody(
  d: CredentialDraft,
  c: CredentialSummary,
): PatchCredentialRequest {
  const body: PatchCredentialRequest = {};
  if (d.keyName !== c.keyName) body.keyName = d.keyName;
  if (d.prefix.trim() !== c.prefix) body.prefix = d.prefix.trim();
  if (d.header.trim() !== c.header) body.header = d.header.trim();
  if (d.template.trim() !== c.template) body.template = d.template.trim();
  if (!sameIds(d.methods, c.methods)) body.methods = d.methods;
  const ids = c.projects.map((p) => p.id);
  if (!sameIds(d.projectIds, ids)) body.projectIds = d.projectIds;
  return body;
}

export function dirtyOf(d: CredentialDraft, c: CredentialSummary): boolean {
  return Object.keys(patchBody(d, c)).length > 0;
}
