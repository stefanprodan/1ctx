// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { smtp, smtpError } from "../../../src/client/data/smtp.ts";
import {
  draftOf,
  offLine,
  resultLine,
  smtpBody,
  smtpDirty,
  smtpFieldOf,
  testLine,
  withSecurity,
} from "../../../src/client/views/admin/Smtp.model.ts";
import { Smtp } from "../../../src/client/views/admin/Smtp.tsx";
import type { SmtpResponse } from "../../../src/shared/api/smtp.ts";
import type { SmtpSettings } from "../../../src/shared/contracts/smtp.ts";

const settings: SmtpSettings = {
  host: "smtp.example.test",
  port: 465,
  security: "tls",
  username: "api_token",
  keyName: "email-relay",
  fromAddress: "noreply@example.test",
  fromName: "1ctx",
  publicAddress: "https://1ctx.example.test",
  updatedAt: 5,
};

const response = (over: Partial<SmtpResponse> = {}): SmtpResponse => ({
  settings,
  enabled: true,
  hasKey: true,
  keys: ["email-relay"],
  to: "root@example.test",
  ...over,
});

describe("the SMTP words", () => {
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
    expect(smtpBody(draftOf(settings))).toEqual({
      body: {
        host: "smtp.example.test",
        port: 465,
        security: "tls",
        username: "api_token",
        keyName: "email-relay",
        fromAddress: "noreply@example.test",
        fromName: "1ctx",
        publicAddress: "https://1ctx.example.test",
      },
    });
    const d = draftOf(settings);
    expect(smtpBody({ ...d, keyName: "" })).toMatchObject({
      field: "keyName",
    });
    expect(smtpBody({ ...d, username: " " })).toMatchObject({
      field: "username",
    });
    expect(smtpBody({ ...d, username: "", keyName: "" })).toMatchObject({
      body: { username: null, keyName: null },
    });
    expect(smtpBody({ ...d, port: "70000" })).toMatchObject({ field: "port" });
    expect(smtpBody({ ...d, fromAddress: "x" })).toMatchObject({
      field: "fromAddress",
    });
    expect(smtpBody({ ...d, host: "" })).toMatchObject({ field: "host" });
  });

  test("dirty only when a field differs from the saved row", () => {
    expect(smtpDirty(draftOf(settings), settings)).toBe(false);
    expect(smtpDirty({ ...draftOf(settings), host: "a" }, settings)).toBe(true);
    expect(smtpDirty(draftOf(null), null)).toBe(false);
  });

  test("a server refusal lands at its field", () => {
    expect(smtpFieldOf("publicAddress must be an origin, with no path")).toBe(
      "publicAddress",
    );
    expect(smtpFieldOf("keyName is required with a username")).toBe("keyName");
    expect(smtpFieldOf("email is not set up")).toBeUndefined();
  });

  test("says why email is off and what a test did", () => {
    expect(offLine(response())).toBeNull();
    expect(offLine(response({ settings: null, enabled: false }))).toBe(
      "Email is off until an SMTP server is saved.",
    );
    expect(offLine(response({ enabled: false, hasKey: false }))).toBe(
      "Email is off: email-relay.key is missing.",
    );
    expect(testLine(response())).toBe(
      "Sends a test email to root@example.test.",
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

describe("the SMTP page", () => {
  afterEach(() => {
    smtp.value = null;
    smtpError.value = null;
  });

  test.serial("one form, nothing to save at rest, Send test email on", () => {
    smtp.value = response();
    const html = render(<Smtp />);
    expect(html.match(/<form\b/g)).toHaveLength(1);
    expect(
      [...html.matchAll(/setting-title">([^<]+)</g)].map((m) => m[1]),
    ).toEqual(["Server", "Send test email"]);
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
      /<button type="button" class="btn btn-small">Send test email/,
    );
  });

  test.serial("says email is off and keeps Send test email off", () => {
    smtp.value = response({ settings: null, enabled: false, to: null });
    const html = render(<Smtp />);
    expect(html).toContain("Email is off until an SMTP server is saved.");
    expect(html).toMatch(/class="btn btn-small" disabled[^>]*>Send test email/);
  });
});
