// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The nodemailer side against a fake SMTP server on loopback: what a
// sent message carries, and every failure turned into its closed word.

import { describe, expect, test } from "bun:test";
import {
  failureOf,
  type Outgoing,
  type SmtpServer,
  smtpSender,
} from "../../../src/server/email/smtp.ts";
import { fakeSmtp, LOOPBACK_CERT } from "../../helpers/smtp.ts";

const message: Outgoing = {
  from: { name: "1ctx", address: "noreply@example.test" },
  to: { name: "Ann Lee", address: "ann@example.test" },
  subject: "Hello",
  text: "First line\n.\nlast line",
  messageId: "<row1@example.test>",
};

const server = (port: number, over: Partial<SmtpServer> = {}): SmtpServer => ({
  host: "127.0.0.1",
  port,
  security: "tls",
  username: "api_token",
  password: "secret-pass",
  ...over,
});

// trusts the fixture's certificate, so verification stays on
const trusting = smtpSender({
  ca: LOOPBACK_CERT,
  timeouts: { connectionTimeout: 2000, greetingTimeout: 500 },
});

describe("the SMTP sender", () => {
  test("sends over TLS with the login, the addresses and the id", async () => {
    const smtp = fakeSmtp({
      tls: true,
      auth: { user: "api_token", pass: "secret-pass" },
    });
    try {
      expect(await trusting(server(smtp.port), message)).toBe("sent");
      expect(smtp.received).toHaveLength(1);
      const got = smtp.received[0]!;
      expect(got.auth).toBe("api_token");
      expect(got.from).toBe("<noreply@example.test>");
      expect(got.to).toEqual(["<ann@example.test>"]);
      expect(got.data).toContain("Message-ID: <row1@example.test>");
      expect(got.data).toContain("From: 1ctx <noreply@example.test>");
      expect(got.data).toContain("To: Ann Lee <ann@example.test>");
      expect(got.data).toContain("Subject: Hello");
      // a lone dot is stuffed, so it never ends the data early
      expect(got.data).toContain("\r\n..\r\n");
    } finally {
      smtp.stop();
    }
  });

  test("upgrades with starttls before the login", async () => {
    const smtp = fakeSmtp({
      starttls: true,
      auth: { user: "api_token", pass: "secret-pass" },
    });
    try {
      const sent = await trusting(
        server(smtp.port, { security: "starttls" }),
        message,
      );
      expect(sent).toBe("sent");
      expect(smtp.received).toHaveLength(1);
      expect(smtp.received[0]!.auth).toBe("api_token");
      // nothing past the upgrade is read in the clear
      const upgrade = smtp.commands.indexOf("STARTTLS");
      expect(upgrade).toBeGreaterThan(-1);
      expect(smtp.commands.indexOf("AUTH PLAIN")).toBeGreaterThan(upgrade);
    } finally {
      smtp.stop();
    }
  });

  test("verifies the certificate", async () => {
    const smtp = fakeSmtp({ tls: true });
    try {
      const strict = smtpSender({ timeouts: { connectionTimeout: 2000 } });
      expect(await strict(server(smtp.port), message)).toBe("tls");
      expect(smtp.received).toHaveLength(0);
    } finally {
      smtp.stop();
    }
  });

  test("refuses starttls a server does not offer", async () => {
    const smtp = fakeSmtp({ auth: { user: "api_token", pass: "secret-pass" } });
    try {
      const sent = await trusting(
        server(smtp.port, { security: "starttls" }),
        message,
      );
      expect(sent).toBe("tls");
      expect(smtp.commands).not.toContain("AUTH PLAIN");
      expect(smtp.received).toHaveLength(0);
    } finally {
      smtp.stop();
    }
  });

  test("says auth, rejected and timeout", async () => {
    const wrong = fakeSmtp({ tls: true, auth: { user: "u", pass: "p" } });
    const refusing = fakeSmtp({
      tls: true,
      auth: { user: "api_token", pass: "secret-pass" },
      rejectRecipient: true,
    });
    const silent = fakeSmtp({ tls: true, silent: true });
    try {
      expect(await trusting(server(wrong.port), message)).toBe("auth");
      expect(await trusting(server(refusing.port), message)).toBe("rejected");
      expect(await trusting(server(silent.port), message)).toBe("timeout");
    } finally {
      wrong.stop();
      refusing.stop();
      silent.stop();
    }
  });

  test("says connect when nothing listens, tls on a plain server", async () => {
    const plain = fakeSmtp();
    const closed = fakeSmtp();
    const port = closed.port;
    closed.stop();
    try {
      expect(await trusting(server(port), message)).toBe("connect");
      expect(await trusting(server(plain.port), message)).toBe("tls");
    } finally {
      plain.stop();
    }
  });

  test("refuses a control character in a header before connecting", async () => {
    const smtp = fakeSmtp({ tls: true });
    try {
      for (const bad of [
        { ...message, subject: "Hi\r\nBcc: evil@example.test" },
        { ...message, to: { ...message.to, name: "Ann\nLee" } },
        { ...message, from: { ...message.from, address: "a@b.test\r" } },
      ]) {
        expect(await trusting(server(smtp.port), bad)).toBe("other");
      }
      expect(smtp.commands).toEqual([]);
    } finally {
      smtp.stop();
    }
  });
});

describe("a failure's word", () => {
  test("follows nodemailer's codes and the socket's own fields", () => {
    const error = (fields: Record<string, unknown>) =>
      Object.assign(new Error("x"), fields);
    expect(failureOf(error({ code: "EAUTH" }))).toBe("auth");
    expect(failureOf(error({ code: "ENOAUTH" }))).toBe("auth");
    expect(failureOf(error({ code: "ETLS" }))).toBe("tls");
    expect(failureOf(error({ code: "ETIMEDOUT" }))).toBe("timeout");
    expect(failureOf(error({ code: "EENVELOPE" }))).toBe("rejected");
    expect(failureOf(error({ code: "EMESSAGE" }))).toBe("rejected");
    expect(failureOf(error({ code: "EDNS" }))).toBe("connect");
    expect(failureOf(error({ code: "ECONNECTION" }))).toBe("connect");
    expect(failureOf(error({ code: "ESOCKET", syscall: "connect" }))).toBe(
      "connect",
    );
    expect(failureOf(error({ code: "ESOCKET", reason: "x" }))).toBe("tls");
    expect(
      failureOf(
        Object.assign(new Error("self signed certificate"), {
          code: "ESOCKET",
        }),
      ),
    ).toBe("tls");
    expect(failureOf(error({ code: "EPROTOCOL", responseCode: 554 }))).toBe(
      "rejected",
    );
    expect(failureOf(error({ code: "EPROTOCOL" }))).toBe("other");
    expect(failureOf("thrown")).toBe("other");
    expect(failureOf(null)).toBe("other");
  });
});
