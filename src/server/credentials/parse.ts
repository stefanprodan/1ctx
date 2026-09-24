// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The credential request parsers: a new credential and a change to one.

import type {
  CreateCredentialRequest,
  PatchCredentialRequest,
} from "../../shared/api/credentials.ts";
import {
  DEFAULT_METHODS,
  HTTP_METHODS,
  type HttpMethod,
  isHttpMethod,
} from "../../shared/contracts/credential.ts";
import {
  HTTP_KEY_PREFIX,
  isName,
  isSecretName,
  MAX_NAME,
  MIN_NAME,
  NAME_CHARACTERS,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import {
  type Checked,
  checkHeaderName,
  checkTemplate,
  normalizePrefix,
} from "./check.ts";
import { orderedMethods } from "./store.ts";

// a row id, as lib/ids.ts makes them
const ID = /^[0-9a-z]{1,32}$/;
// more than any project may hold, so a list past it is a typo
const MAX_PROJECTS = 256;

function checked<T>(result: Checked<T>): T {
  if (!result.ok) throw new BadRequest(result.error);
  return result.value;
}

export function parseName(value: unknown): string {
  if (!isName(value)) {
    throw new BadRequest(
      `name must be ${MIN_NAME} to ${MAX_NAME} ${NAME_CHARACTERS}`,
    );
  }
  return value;
}

export function parseKeyName(value: unknown): string {
  if (!isSecretName(HTTP_KEY_PREFIX, value)) {
    throw new BadRequest(
      "keyName must be http- followed by 1 to 48 lowercase letters, " +
        "digits and dashes, starting with a letter or digit",
    );
  }
  return value;
}

export const parsePrefix = (value: unknown) => checked(normalizePrefix(value));
export const parseHeader = (value: unknown) => checked(checkHeaderName(value));
export const parseTemplate = (value: unknown) => checked(checkTemplate(value));

export function parseMethods(value: unknown): HttpMethod[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > HTTP_METHODS.length ||
    !value.every(isHttpMethod) ||
    new Set(value).size !== value.length
  ) {
    throw new BadRequest(
      `methods must be distinct names from ${HTTP_METHODS.join(", ")}`,
    );
  }
  return orderedMethods(value);
}

function parseProjectIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_PROJECTS ||
    !value.every((id) => typeof id === "string" && ID.test(id)) ||
    new Set(value).size !== value.length
  ) {
    throw new BadRequest("projectIds must be distinct project ids");
  }
  return value as string[];
}

export function parseCreate(body: unknown): Required<CreateCredentialRequest> {
  const b = fields(body, [
    "name",
    "keyName",
    "prefix",
    "header",
    "template",
    "methods",
    "projectIds",
  ]);
  return {
    name: parseName(b.name),
    keyName: parseKeyName(b.keyName),
    prefix: parsePrefix(b.prefix),
    header: parseHeader(b.header),
    template: parseTemplate(b.template),
    methods:
      b.methods === undefined ? [...DEFAULT_METHODS] : parseMethods(b.methods),
    projectIds: b.projectIds === undefined ? [] : parseProjectIds(b.projectIds),
  };
}

export function parsePatch(body: unknown): PatchCredentialRequest {
  const b = fields(body, [
    "keyName",
    "prefix",
    "header",
    "template",
    "methods",
    "projectIds",
  ]);
  const parsers = {
    keyName: parseKeyName,
    prefix: parsePrefix,
    header: parseHeader,
    template: parseTemplate,
    methods: parseMethods,
    projectIds: parseProjectIds,
  };
  const out: Record<string, unknown> = {};
  for (const [key, parse] of Object.entries(parsers)) {
    if (Object.hasOwn(b, key)) out[key] = parse(b[key]);
  }
  return out as PatchCredentialRequest;
}
