// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { PutSmtpRequest } from "../../shared/api/smtp.ts";
import {
  isSmtpSecurity,
  type SmtpSecurity,
} from "../../shared/contracts/smtp.ts";
import {
  EMAIL_KEY_PREFIX,
  isEmail,
  isSecretName,
  MAX_FULL_NAME,
  secretNameRule,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { hasControl, publicOrigin } from "./rules.ts";

// a DNS name's ceiling
const MAX_HOST = 253;
// the SASL ceiling on a login's name
const MAX_USERNAME = 255;
const MAX_ADDRESS = 2048;
// a host name or an IP address, never a URL
const HOST = /^[A-Za-z0-9.:-]+$/;

const SMTP_FIELDS = [
  "host",
  "port",
  "security",
  "username",
  "keyName",
  "fromAddress",
  "fromName",
  "publicAddress",
] as const;

export function parseHost(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > MAX_HOST ||
    !HOST.test(value)
  ) {
    throw new BadRequest("host must be a host name or an IP address");
  }
  return value.toLowerCase();
}

export function parsePort(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535
  ) {
    throw new BadRequest("port must be 1 to 65535");
  }
  return value;
}

export function parseSecurity(value: unknown): SmtpSecurity {
  if (!isSmtpSecurity(value)) {
    throw new BadRequest("security must be tls or starttls");
  }
  return value;
}

export function parseSmtpUsername(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > MAX_USERNAME ||
    hasControl(value)
  ) {
    throw new BadRequest(
      `username must be 1 to ${MAX_USERNAME} characters on one line, or null`,
    );
  }
  return value;
}

export function parseSmtpKeyName(value: unknown): string | null {
  if (value === null) return null;
  if (!isSecretName(EMAIL_KEY_PREFIX, value)) {
    throw new BadRequest(
      `keyName must be ${secretNameRule(EMAIL_KEY_PREFIX)}, or null`,
    );
  }
  return value;
}

export function parseFromAddress(value: unknown): string {
  if (!isEmail(value) || hasControl(value)) {
    throw new BadRequest("fromAddress must be an email address");
  }
  return value.toLowerCase();
}

export function parseFromName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    value.length > MAX_FULL_NAME ||
    hasControl(value)
  ) {
    throw new BadRequest(
      `fromName must be 1 to ${MAX_FULL_NAME} characters on one line`,
    );
  }
  return value;
}

export function parsePublicAddress(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_ADDRESS) {
    throw new BadRequest("publicAddress must be a URL");
  }
  const got = publicOrigin(value);
  if (!got.ok) throw new BadRequest(`publicAddress ${got.error}`);
  return got.origin;
}

// a login needs both halves, so one alone is refused rather than
// sending a name with no password
export function pairProblem(
  username: string | null,
  keyName: string | null,
): string | null {
  if (username !== null && keyName === null) {
    return "keyName is required with a username";
  }
  if (username === null && keyName !== null) {
    return "username is required with a keyName";
  }
  return null;
}

export function parseSmtp(body: unknown): PutSmtpRequest {
  const b = fields(body, SMTP_FIELDS);
  for (const name of SMTP_FIELDS) {
    if (!Object.hasOwn(b, name)) throw new BadRequest(`${name} is required`);
  }
  const parsed: PutSmtpRequest = {
    host: parseHost(b.host),
    port: parsePort(b.port),
    security: parseSecurity(b.security),
    username: parseSmtpUsername(b.username),
    keyName: parseSmtpKeyName(b.keyName),
    fromAddress: parseFromAddress(b.fromAddress),
    fromName: parseFromName(b.fromName),
    publicAddress: parsePublicAddress(b.publicAddress),
  };
  const pair = pairProblem(parsed.username, parsed.keyName);
  if (pair !== null) throw new BadRequest(pair);
  return parsed;
}
