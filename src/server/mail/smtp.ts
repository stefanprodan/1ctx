// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one file that imports nodemailer: a message to the admin's SMTP
// server over one connection, and the error turned into a closed word.
// Certificates are always verified. Addresses go in as objects, never
// strings it would parse, and a header value with a control character
// is refused here too, so safety does not rest on the package.

import { createTransport } from "nodemailer";
import type { MailFailure, MailSecurity } from "../../shared/contracts/mail.ts";
import { hasControl } from "./rules.ts";

export type Address = { name: string; address: string };

export type SmtpServer = {
  host: string;
  port: number;
  security: MailSecurity;
  username: string | null;
  password: string | null;
};

export type Outgoing = {
  from: Address;
  to: Address;
  subject: string;
  text: string;
  html?: string;
  messageId: string;
};

export type SendResult = "sent" | MailFailure;

// what actually sends; a test passes a fake that records
export type Mailer = (
  server: SmtpServer,
  mail: Outgoing,
) => Promise<SendResult>;

export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
};

export function headersProblem(mail: Outgoing): boolean {
  return [
    mail.from.name,
    mail.from.address,
    mail.to.name,
    mail.to.address,
    mail.subject,
    mail.messageId,
  ].some(hasControl);
}

// nodemailer folds a socket's own error into ESOCKET; a TLS failure
// keeps the library's fields or its words, a connect keeps its syscall
const TLS_WORDS = /certificate|self.signed|ssl|tls|altname|handshake/i;

export function failureOf(error: unknown): MailFailure {
  const e = (error ?? {}) as {
    code?: unknown;
    responseCode?: unknown;
    message?: unknown;
  };
  switch (e.code) {
    case "EAUTH":
    case "ENOAUTH":
      return "auth";
    case "ETLS":
    case "EREQUIRETLS":
      return "tls";
    case "ETIMEDOUT":
      return "timeout";
    case "EENVELOPE":
    case "EMESSAGE":
      return "rejected";
    case "EDNS":
    case "ECONNECTION":
      return "connect";
    case "ESOCKET":
      if ("syscall" in e) return "connect";
      if ("library" in e || "reason" in e) return "tls";
      return typeof e.message === "string" && TLS_WORDS.test(e.message)
        ? "tls"
        : "connect";
  }
  return typeof e.responseCode === "number" && e.responseCode >= 500
    ? "rejected"
    : "other";
}

// options: a CA to trust beside the system's and shorter timeouts, for
// the tests' server on loopback alone
export function smtpMailer(
  options: { ca?: string; timeouts?: Partial<typeof SMTP_TIMEOUTS> } = {},
): Mailer {
  return async (server, mail) => {
    if (headersProblem(mail)) return "other";
    const transport = createTransport({
      host: server.host,
      port: server.port,
      secure: server.security === "tls",
      requireTLS: server.security === "starttls",
      ...(server.username === null || server.password === null
        ? {}
        : { auth: { user: server.username, pass: server.password } }),
      tls: {
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      },
      ...SMTP_TIMEOUTS,
      ...options.timeouts,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
    });
    try {
      await transport.sendMail({
        from: mail.from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        ...(mail.html === undefined ? {} : { html: mail.html }),
        messageId: mail.messageId,
      });
      return "sent";
    } catch (error) {
      return failureOf(error);
    } finally {
      transport.close();
    }
  };
}
