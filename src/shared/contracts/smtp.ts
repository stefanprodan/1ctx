// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The instance's SMTP server as an admin sets it, and the closed words
// a send ends in. The password is a key file the row names, never a
// value on the wire.

// tls: TLS from the first byte. starttls: plain, then upgraded, and
// refused when the server does not offer the upgrade
export const SMTP_SECURITY = ["tls", "starttls"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];
export function isSmtpSecurity(value: unknown): value is SmtpSecurity {
  return SMTP_SECURITY.includes(value as SmtpSecurity);
}

// why a send failed: the only words a page, a log or a row holds,
// never the server's own text
export const SMTP_FAILURES = [
  "auth",
  "tls",
  "connect",
  "rejected",
  "timeout",
  "other",
] as const;
export type SmtpFailure = (typeof SMTP_FAILURES)[number];

export const DEFAULT_FROM_NAME = "1ctx";

export type SmtpSettings = {
  host: string;
  port: number;
  security: SmtpSecurity;
  // both null for a server that takes email without a login
  username: string | null;
  keyName: string | null;
  fromAddress: string;
  fromName: string;
  // the origin every link an email carries starts with
  publicAddress: string;
  updatedAt: number;
};
