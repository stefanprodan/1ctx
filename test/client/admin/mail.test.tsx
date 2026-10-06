// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { mail, mailError } from "../../../src/client/data/mail.ts";
import {
  draftOf,
  mailBody,
  mailDirty,
  mailFieldOf,
  offLine,
  resultLine,
  testLine,
  withSecurity,
} from "../../../src/client/views/admin/Mail.model.ts";
import { Mail } from "../../../src/client/views/admin/Mail.tsx";
import type { MailResponse } from "../../../src/shared/api/mail.ts";
import type { MailSettings } from "../../../src/shared/contracts/mail.ts";

const settings: MailSettings = {
  host: "smtp.example.test",
  port: 465,
  security: "tls",
  username: "api_token",
  keyName: "email-relay",
  fromAddress: "mail@example.test",
  fromName: "1ctx",
  publicAddress: "https://1ctx.example.test",
  updatedAt: 5,
};

const response = (over: Partial<MailResponse> = {}): MailResponse => ({
  settings,
  enabled: true,
  hasKey: true,
  keys: ["email-relay"],
  to: "root@example.test",
  ...over,
});

describe("the Mail words", () => {
  test("a new draft starts on TLS at 465 from 1ctx", () => {
    expect(draftOf(null)).toMatchObject({
      port: "465",
      security: "tls",
      fromName: "1ctx",
      keyName: "",
    });
    expect(withSecurity(draftOf(null), "starttls").port).toBe("587");
    const custom = { ...draftOf(null), port: "2525" };
    expect(withSecurity(custom, "starttls").port).toBe("2525");
  });

  test("the body holds every field, a login whole or none", () => {
    expect(mailBody(draftOf(settings))).toEqual({
      body: {
        host: "smtp.example.test",
        port: 465,
        security: "tls",
        username: "api_token",
        keyName: "email-relay",
        fromAddress: "mail@example.test",
        fromName: "1ctx",
        publicAddress: "https://1ctx.example.test",
      },
    });
    const d = draftOf(settings);
    expect(mailBody({ ...d, keyName: "" })).toMatchObject({
      field: "keyName",
    });
    expect(mailBody({ ...d, username: " " })).toMatchObject({
      field: "username",
    });
    expect(mailBody({ ...d, username: "", keyName: "" })).toMatchObject({
      body: { username: null, keyName: null },
    });
    expect(mailBody({ ...d, port: "70000" })).toMatchObject({ field: "port" });
    expect(mailBody({ ...d, fromAddress: "x" })).toMatchObject({
      field: "fromAddress",
    });
    expect(mailBody({ ...d, host: "" })).toMatchObject({ field: "host" });
  });

  test("dirty only when a field differs from the saved row", () => {
    expect(mailDirty(draftOf(settings), settings)).toBe(false);
    expect(mailDirty({ ...draftOf(settings), host: "a" }, settings)).toBe(true);
    expect(mailDirty(draftOf(null), null)).toBe(false);
  });

  test("a server refusal lands at its field", () => {
    expect(mailFieldOf("publicAddress must be an origin, with no path")).toBe(
      "publicAddress",
    );
    expect(mailFieldOf("keyName is required with a username")).toBe("keyName");
    expect(mailFieldOf("mail is not set up")).toBeUndefined();
  });

  test("says why mail is off and what a test did", () => {
    expect(offLine(response())).toBeNull();
    expect(offLine(response({ settings: null, enabled: false }))).toBe(
      "Mail is off until a server is saved.",
    );
    expect(offLine(response({ enabled: false, hasKey: false }))).toBe(
      "Mail is off: email-relay.key is missing.",
    );
    expect(testLine(response())).toBe(
      "Sends a test mail to root@example.test.",
    );
    expect(testLine(response(), true)).toBe("Save the changes to test them.");
    expect(testLine(response({ to: null }))).toBe(
      "Your account has no real email.",
    );
    expect(resultLine("sent", "root@example.test")).toBe(
      "Sent to root@example.test.",
    );
    expect(resultLine("auth", null)).toBe(
      "Sign in failed. Check the username and the key file.",
    );
  });
});

describe("the Mail page", () => {
  afterEach(() => {
    mail.value = null;
    mailError.value = null;
  });

  test.serial("one form, nothing to save at rest, Send test on", () => {
    mail.value = response();
    const html = render(<Mail />);
    expect(html.match(/<form\b/g)).toHaveLength(1);
    expect(
      [...html.matchAll(/setting-title">([^<]+)</g)].map((m) => m[1]),
    ).toEqual(["Server", "Send test"]);
    for (const name of [
      "host",
      "port",
      "username",
      "fromAddress",
      "fromName",
      "publicAddress",
    ]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain('value="smtp.example.test"');
    expect(html).not.toContain("Unsaved changes");
    expect(html).not.toContain("setting-alert");
    expect(html).toMatch(
      /<button type="button" class="btn btn-small">Send test/,
    );
  });

  test.serial("says mail is off and keeps Send test off", () => {
    mail.value = response({ settings: null, enabled: false, to: null });
    const html = render(<Mail />);
    expect(html).toContain("Mail is off until a server is saved.");
    expect(html).toMatch(/class="btn btn-small" disabled[^>]*>Send test/);
  });
});
