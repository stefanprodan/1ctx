// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The instance's one SMTP server as a document, applied through the
// mail routes. Its name is a label: there is one server, so a second
// document is refused and the first updates whatever is held.

import type { MailResponse, PutMailRequest } from "../../shared/api/mail.ts";
import {
  DEFAULT_FROM_NAME,
  type MailSecurity,
} from "../../shared/contracts/mail.ts";
import {
  pairProblem,
  parseFromAddress,
  parseFromName,
  parseHost,
  parseMailKeyName,
  parseMailUsername,
  parsePort,
  parsePublicAddress,
  parseSecurity,
} from "../mail/index.ts";
import { type Action, type Client, difference, required } from "./client.ts";
import { optionalSpec } from "./fields.ts";

export type MailSpec = {
  host?: string;
  port?: number;
  security?: MailSecurity;
  username?: string | null;
  // an email- key file's name, the password; null takes it off
  keyFrom?: string | null;
  fromAddress?: string;
  fromName?: string;
  publicAddress?: string;
};

export const MAIL_REQUIRED = [
  "host",
  "port",
  "security",
  "fromAddress",
  "publicAddress",
] as const;

// a new server's login, checked offline: both halves or neither
export function newMailPair(spec: MailSpec): string | null {
  const username = spec.username ?? null;
  const keyFrom = spec.keyFrom ?? null;
  if (username !== null && keyFrom === null) {
    return "spec.keyFrom is required with spec.username";
  }
  if (username === null && keyFrom !== null) {
    return "spec.username is required with spec.keyFrom";
  }
  return null;
}

export function mailSpec(value: unknown): MailSpec {
  return optionalSpec<MailSpec>(value, {
    host: parseHost,
    port: parsePort,
    security: parseSecurity,
    username: parseMailUsername,
    keyFrom: parseMailKeyName,
    fromAddress: parseFromAddress,
    fromName: parseFromName,
    publicAddress: parsePublicAddress,
  });
}

export async function applyMail(
  api: Client,
  doc: { spec: MailSpec },
): Promise<Action> {
  const { settings: held } = await api.call<MailResponse>(
    "GET",
    "/api/admin/mail",
  );
  const { keyFrom, ...fields } = doc.spec;
  const desired: PutMailRequest = {
    host: required(fields.host ?? held?.host, "host"),
    port: required(fields.port ?? held?.port, "port"),
    security: required(fields.security ?? held?.security, "security"),
    username:
      fields.username === undefined
        ? (held?.username ?? null)
        : fields.username,
    keyName: keyFrom === undefined ? (held?.keyName ?? null) : keyFrom,
    fromAddress: required(
      fields.fromAddress ?? held?.fromAddress,
      "fromAddress",
    ),
    fromName: fields.fromName ?? held?.fromName ?? DEFAULT_FROM_NAME,
    publicAddress: required(
      fields.publicAddress ?? held?.publicAddress,
      "publicAddress",
    ),
  };
  const pair = pairProblem(desired.username, desired.keyName);
  if (pair !== null) throw new Error(pair);
  if (held !== null && !Object.keys(difference(held, desired)).length) {
    return "unchanged";
  }
  await api.call("PUT", "/api/admin/mail", desired);
  return held === null ? "created" : "updated";
}
