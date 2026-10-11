// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { type Signal, signal } from "@preact/signals";
import { options } from "preact";
import { render } from "preact-render-to-string";
import { loadSmtp, smtp, smtpError } from "../../../src/client/data/smtp.ts";
import { Save } from "../../../src/client/lib/save.ts";
import type { SmtpDraft } from "../../../src/client/views/admin/Smtp.model.ts";
import {
  agentEmailLine,
  draftOf,
  offLine,
  resultLine,
  smtpBody,
  smtpDirty,
  smtpFieldOf,
  testLine,
  withSecurity,
} from "../../../src/client/views/admin/Smtp.model.ts";
import {
  Smtp,
  SmtpCards,
  type Tested,
} from "../../../src/client/views/admin/Smtp.tsx";
import type { SmtpResponse } from "../../../src/shared/api/smtp.ts";
import type { SmtpSettings } from "../../../src/shared/contracts/smtp.ts";
import { settle } from "../../helpers/async.ts";
import { deferredFetch } from "../../helpers/client-fetch.ts";

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

describe("the agents' email switch", () => {
  test("says what it means, waiting for the server when it is not set up", () => {
    expect(agentEmailLine(false, true)).toBe("Agents cannot email users.");
    expect(agentEmailLine(true, false)).toBe(
      "Agents can email users once the server is set up.",
    );
    expect(agentEmailLine(true, true)).toContain("turned email from agents on");
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
    // the sender is an address, so phones offer the email keyboard
    expect(html).toContain('name="fromAddress" type="email"');
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

// what one render of the cards draws and the handlers it binds; the
// signals carry the page's state from one render to the next
function draw(drafted: Signal<SmtpDraft | null>, tested: Signal<Tested>) {
  const inputs: Record<string, (e: Event) => void> = {};
  let submit: ((e: Event) => void) | undefined;
  let sendTest: (() => void) | undefined;
  let save: Save | undefined;
  const previous = options.vnode;
  options.vnode = (v) => {
    previous?.(v);
    const props = v.props as Record<string, unknown>;
    if (v.type === "input" && typeof props.name === "string") {
      inputs[props.name] = props.onInput as (e: Event) => void;
    }
    if (v.type === "form") submit = props.onSubmit as (e: Event) => void;
    if (v.type === "button" && props.class === "btn btn-small") {
      sendTest = props.onClick as () => void;
    }
    if (props.save instanceof Save) save = props.save;
  };
  let html: string;
  try {
    html = render(
      <SmtpCards state={smtp.value!} drafted={drafted} tested={tested} />,
    );
  } finally {
    options.vnode = previous;
  }
  const type = (name: string, value: string) =>
    inputs[name]!({ currentTarget: { value } } as unknown as Event);
  return {
    html,
    type,
    submit: () => submit!(new Event("submit", { cancelable: true })),
    sendTest: () => sendTest!(),
    save: save!,
    testOff: /class="btn btn-small" disabled[^>]*>/.test(html),
  };
}

describe("the SMTP page flows", () => {
  // its hooks swap globalThis.fetch for this describe's serial tests
  // alone, not the file's concurrent ones
  const calls = deferredFetch();
  const sentBody = (n: number) => JSON.parse(String(calls[n]!.init?.body));

  afterEach(() => {
    smtp.value = null;
    smtpError.value = null;
  });

  test.serial("loads the server, then draws it", async () => {
    const loading = loadSmtp();
    expect(render(<Smtp />)).not.toContain('name="host"');
    expect(calls.map((c) => c.url)).toEqual(["/api/admin/smtp"]);
    calls[0]!.answer(Response.json(response()));
    await loading;
    expect(smtp.value).toEqual(response());
    expect(render(<Smtp />)).toContain('value="smtp.example.test"');
  });

  test.serial("a failed load says why", async () => {
    const loading = loadSmtp();
    calls[0]!.answer(Response.json({ error: "forbidden" }, { status: 403 }));
    await loading;
    expect(smtp.value).toBeNull();
    expect(smtpError.value).toEqual({ words: "forbidden", status: 403 });
  });

  test.serial(
    "an edit holds Send test email off, a save clears its result",
    async () => {
      smtp.value = response();
      const drafted = signal<SmtpDraft | null>(null);
      const tested = signal<Tested>({
        line: "Sent to root@example.test.",
        failed: false,
      });
      const rest = draw(drafted, tested);
      expect(rest.testOff).toBe(false);
      expect(rest.html).toContain("Sent to root@example.test.");
      rest.type("host", "smtp2.example.test");
      const edited = draw(drafted, tested);
      expect(edited.testOff).toBe(true);
      expect(edited.html).toContain("Unsaved changes");
      expect(edited.html).toContain("Save the changes to test them.");
      edited.submit();
      await settle();
      expect(calls[0]!.url).toBe("/api/admin/smtp");
      expect(calls[0]!.init?.method).toBe("PUT");
      expect(sentBody(0)).toMatchObject({ host: "smtp2.example.test" });
      // the same updatedAt: nothing but the save itself clears the result
      calls[0]!.answer(
        Response.json(
          response({ settings: { ...settings, host: "smtp2.example.test" } }),
        ),
      );
      await settle();
      expect(edited.save.status.value).toBe("done");
      expect(drafted.value).toBeNull();
      expect(tested.value).toBeNull();
      const saved = draw(drafted, tested);
      expect(saved.testOff).toBe(false);
      expect(saved.html).toContain('value="smtp2.example.test"');
      expect(saved.html).not.toContain("smtp-result");
      expect(saved.html).not.toContain("Unsaved changes");
      edited.save.dispose();
    },
  );

  test.serial("a refused save keeps the edit and Send test off", async () => {
    smtp.value = response();
    const drafted = signal<SmtpDraft | null>(null);
    const tested = signal<Tested>(null);
    draw(drafted, tested).type("publicAddress", "https://a.test/x");
    const edited = draw(drafted, tested);
    edited.submit();
    await settle();
    calls[0]!.answer(
      Response.json(
        { error: "publicAddress must be an origin, with no path" },
        { status: 400 },
      ),
    );
    await settle();
    expect(edited.save.fieldError("publicAddress")).toBe(
      "PublicAddress must be an origin, with no path.",
    );
    expect(smtp.value).toEqual(response());
    expect(drafted.value?.publicAddress).toBe("https://a.test/x");
    expect(draw(drafted, tested).testOff).toBe(true);
  });

  test.serial("Send test email says sent, or the failure's word", async () => {
    smtp.value = response();
    const drafted = signal<SmtpDraft | null>(null);
    const tested = signal<Tested>(null);
    draw(drafted, tested).sendTest();
    expect(calls[0]!.url).toBe("/api/admin/smtp/test");
    expect(calls[0]!.init?.method).toBe("POST");
    const sending = draw(drafted, tested);
    expect(sending.testOff).toBe(true);
    expect(sending.html).toMatch(/disabled[^>]*>Sending</);
    calls[0]!.answer(Response.json({ result: "sent" }));
    await settle();
    expect(draw(drafted, tested).html).toContain(
      'class="smtp-result" role="status">Sent to root@example.test.',
    );
    draw(drafted, tested).sendTest();
    expect(draw(drafted, tested).html).not.toContain("smtp-result");
    calls[1]!.answer(Response.json({ result: "auth" }));
    await settle();
    expect(draw(drafted, tested).html).toContain(
      'class="smtp-result error" role="status">Sign in failed. Check the username and the key file.',
    );
    draw(drafted, tested).sendTest();
    calls[2]!.answer(
      Response.json({ error: "email is not set up" }, { status: 409 }),
    );
    await settle();
    expect(tested.value).toEqual({
      line: "Email is not set up.",
      failed: true,
    });
  });

  test.serial(
    "a result cleared while a test is out drops its answer",
    async () => {
      smtp.value = response();
      const drafted = signal<SmtpDraft | null>(null);
      const tested = signal<Tested>(null);
      draw(drafted, tested).sendTest();
      tested.value = null;
      calls[0]!.answer(Response.json({ result: "sent" }));
      await settle();
      expect(tested.value).toBeNull();
    },
  );
});
