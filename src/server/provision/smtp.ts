// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The instance's one SMTP server as a document, applied through the
// SMTP routes. Its name is a label: there is one server, so a second
// document is refused and the first updates whatever is held.

import type { PutSmtpRequest, SmtpResponse } from "../../shared/api/smtp.ts";
import {
  DEFAULT_FROM_NAME,
  type SmtpSecurity,
} from "../../shared/contracts/smtp.ts";
import {
  pairProblem,
  parseFromAddress,
  parseFromName,
  parseHost,
  parsePort,
  parsePublicAddress,
  parseSecurity,
  parseSmtpKeyName,
  parseSmtpUsername,
} from "../email/index.ts";
import { type Action, type Client, difference, required } from "./client.ts";
import { optionalSpec } from "./fields.ts";

export type SmtpServerSpec = {
  host?: string;
  port?: number;
  security?: SmtpSecurity;
  username?: string | null;
  // an email- key file's name, the password; null takes it off
  keyFrom?: string | null;
  fromAddress?: string;
  fromName?: string;
  publicAddress?: string;
};

export const SMTP_REQUIRED = [
  "host",
  "port",
  "security",
  "fromAddress",
  "publicAddress",
] as const;

// a new server's login, checked offline: both halves or neither
export function newSmtpPair(spec: SmtpServerSpec): string | null {
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

export function smtpServerSpec(value: unknown): SmtpServerSpec {
  return optionalSpec<SmtpServerSpec>(value, {
    host: parseHost,
    port: parsePort,
    security: parseSecurity,
    username: parseSmtpUsername,
    keyFrom: parseSmtpKeyName,
    fromAddress: parseFromAddress,
    fromName: parseFromName,
    publicAddress: parsePublicAddress,
  });
}

export async function applySmtpServer(
  api: Client,
  doc: { spec: SmtpServerSpec },
): Promise<Action> {
  const { settings: held } = await api.call<SmtpResponse>(
    "GET",
    "/api/admin/smtp",
  );
  const { keyFrom, ...fields } = doc.spec;
  const desired: PutSmtpRequest = {
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
  await api.call("PUT", "/api/admin/smtp", desired);
  return held === null ? "created" : "updated";
}
