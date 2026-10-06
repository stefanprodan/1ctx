// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  PutSmtpRequest,
  SmtpResponse,
  SmtpTestResponse,
} from "../../../shared/api/smtp.ts";
import {
  DEFAULT_FROM_NAME,
  type SmtpSecurity,
  type SmtpSettings,
} from "../../../shared/contracts/smtp.ts";
import { isEmail } from "../../../shared/words.ts";
import { NO_KEY } from "../../lib/secrets.ts";

// what the form holds: text as typed, the key as the select's value
export type SmtpDraft = {
  host: string;
  port: string;
  security: SmtpSecurity;
  username: string;
  keyName: string;
  fromAddress: string;
  fromName: string;
  publicAddress: string;
};

export type SmtpField = keyof SmtpDraft;

// the ports each security word is served on by convention
const PORTS: Record<SmtpSecurity, string> = { tls: "465", starttls: "587" };

export const SECURITY_OPTIONS: { value: SmtpSecurity; label: string }[] = [
  { value: "tls", label: "TLS" },
  { value: "starttls", label: "STARTTLS" },
];

export function draftOf(settings: SmtpSettings | null): SmtpDraft {
  if (settings === null) {
    return {
      host: "",
      port: PORTS.tls,
      security: "tls",
      username: "",
      keyName: NO_KEY,
      fromAddress: "",
      fromName: DEFAULT_FROM_NAME,
      publicAddress: "",
    };
  }
  return {
    host: settings.host,
    port: String(settings.port),
    security: settings.security,
    username: settings.username ?? "",
    keyName: settings.keyName ?? NO_KEY,
    fromAddress: settings.fromAddress,
    fromName: settings.fromName,
    publicAddress: settings.publicAddress,
  };
}

// a security flip moves the port too, while it is the other's default
export function withSecurity(
  draft: SmtpDraft,
  security: SmtpSecurity,
): SmtpDraft {
  const port = draft.port === PORTS[draft.security] ? PORTS[security] : null;
  return { ...draft, security, port: port ?? draft.port };
}

const PORT = /^[0-9]{1,5}$/;

export function smtpBody(
  d: SmtpDraft,
): { body: PutSmtpRequest } | { field: SmtpField; error: string } {
  const host = d.host.trim();
  if (host === "") return { field: "host", error: "Enter a host" };
  const port = Number(d.port.trim());
  if (!PORT.test(d.port.trim()) || port < 1 || port > 65535) {
    return { field: "port", error: "A port is 1 to 65535" };
  }
  const username = d.username.trim();
  if (username !== "" && d.keyName === NO_KEY) {
    return { field: "keyName", error: "Pick the password's key file" };
  }
  if (username === "" && d.keyName !== NO_KEY) {
    return { field: "username", error: "Enter the username" };
  }
  const fromAddress = d.fromAddress.trim().toLowerCase();
  if (!isEmail(fromAddress)) {
    return { field: "fromAddress", error: "Not an email address" };
  }
  const fromName = d.fromName.trim();
  if (fromName === "") return { field: "fromName", error: "Enter a name" };
  const publicAddress = d.publicAddress.trim();
  if (publicAddress === "") {
    return { field: "publicAddress", error: "Enter the address users open" };
  }
  return {
    body: {
      host,
      port,
      security: d.security,
      username: username === "" ? null : username,
      keyName: d.keyName === NO_KEY ? null : d.keyName,
      fromAddress,
      fromName,
      publicAddress,
    },
  };
}

export function smtpDirty(d: SmtpDraft, settings: SmtpSettings | null) {
  const saved = draftOf(settings);
  return (Object.keys(saved) as SmtpField[]).some(
    (field) => d[field].trim() !== saved[field],
  );
}

// the server's words name the field first
export function smtpFieldOf(message: string): SmtpField | undefined {
  const first = message.split(" ")[0]!.toLowerCase();
  const fields: Record<string, SmtpField> = {
    host: "host",
    port: "port",
    security: "security",
    username: "username",
    keyname: "keyName",
    fromaddress: "fromAddress",
    fromname: "fromName",
    publicaddress: "publicAddress",
  };
  return fields[first];
}

// why email is off, null while it is on
export function offLine(state: SmtpResponse): string | null {
  if (state.enabled) return null;
  const settings = state.settings;
  if (settings === null) {
    return "Email is off until an SMTP server is saved.";
  }
  return `Email is off: ${settings.keyName}.key is missing.`;
}

export function testLine(state: SmtpResponse, dirty = false): string {
  if (state.to === null) return "Your account has no real email.";
  if (dirty) return "Save the changes to test them.";
  return `Sends a test email to ${state.to}.`;
}

const FAILED: Record<Exclude<SmtpTestResponse["result"], "sent">, string> = {
  auth: "Sign in failed. Check the username and the key file.",
  tls: "TLS failed. Check the security and the port.",
  connect: "Could not connect. Check the host and the port.",
  rejected: "The server refused the email.",
  timeout: "The server did not answer in time.",
  other: "The email was not sent.",
};

export function resultLine(
  result: SmtpTestResponse["result"],
  to: string | null,
): string {
  return result === "sent" ? `Sent to ${to ?? "your email"}.` : FAILED[result];
}
