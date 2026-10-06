// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  MailResponse,
  MailTestResponse,
  PutMailRequest,
} from "../../../shared/api/mail.ts";
import {
  DEFAULT_FROM_NAME,
  type MailSecurity,
  type MailSettings,
} from "../../../shared/contracts/mail.ts";
import { isEmail } from "../../../shared/words.ts";
import { NO_KEY } from "../../lib/secrets.ts";

// what the form holds: text as typed, the key as the select's value
export type MailDraft = {
  host: string;
  port: string;
  security: MailSecurity;
  username: string;
  keyName: string;
  fromAddress: string;
  fromName: string;
  publicAddress: string;
};

export type MailField = keyof MailDraft;

// the ports each security word is served on by convention
const PORTS: Record<MailSecurity, string> = { tls: "465", starttls: "587" };

export const SECURITY_OPTIONS: { value: MailSecurity; label: string }[] = [
  { value: "tls", label: "TLS" },
  { value: "starttls", label: "STARTTLS" },
];

export function draftOf(settings: MailSettings | null): MailDraft {
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
  draft: MailDraft,
  security: MailSecurity,
): MailDraft {
  const port = draft.port === PORTS[draft.security] ? PORTS[security] : null;
  return { ...draft, security, port: port ?? draft.port };
}

const PORT = /^[0-9]{1,5}$/;

export function mailBody(
  d: MailDraft,
): { body: PutMailRequest } | { field: MailField; error: string } {
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

export function mailDirty(d: MailDraft, settings: MailSettings | null) {
  const saved = draftOf(settings);
  return (Object.keys(saved) as MailField[]).some(
    (field) => d[field].trim() !== saved[field],
  );
}

// the server's words name the field first
export function mailFieldOf(message: string): MailField | undefined {
  const first = message.split(" ")[0]!.toLowerCase();
  const fields: Record<string, MailField> = {
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

// why mail is off, null while it is on
export function offLine(state: MailResponse): string | null {
  if (state.enabled) return null;
  const settings = state.settings;
  if (settings === null) {
    return "Mail is off until a server is saved.";
  }
  return `Mail is off: ${settings.keyName}.key is missing.`;
}

export function testLine(state: MailResponse, dirty = false): string {
  if (state.to === null) return "Your account has no real email.";
  if (dirty) return "Save the changes to test them.";
  return `Sends a test mail to ${state.to}.`;
}

const FAILED: Record<Exclude<MailTestResponse["result"], "sent">, string> = {
  auth: "Sign in failed. Check the username and the key file.",
  tls: "TLS failed. Check the security and the port.",
  connect: "Could not connect. Check the host and the port.",
  rejected: "The server refused the mail.",
  timeout: "The server did not answer in time.",
  other: "The mail was not sent.",
};

export function resultLine(
  result: MailTestResponse["result"],
  to: string | null,
): string {
  return result === "sent" ? `Sent to ${to ?? "your email"}.` : FAILED[result];
}
