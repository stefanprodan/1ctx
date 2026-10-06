// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The frame around an agent's email and an alert: the subject's tag,
// the line saying who wrote it where, the text set apart, the one
// trusted link, and the row's body round trip.

import { describe, expect, test } from "bun:test";
import { chatHref, runHref } from "../../../src/client/lib/hrefs.ts";
import {
  type AgentEmail,
  type AlertEmail,
  agentEmail as agentFrame,
  alertEmail as alertFrame,
  type OutboxRow,
  packBody,
  sessionPath,
  sessionPrepare,
  unpackBody,
  withLink,
} from "../../../src/server/email/index.ts";
import type { UserRow } from "../../../src/server/users/index.ts";

const LINK = "https://1ctx.example.test/chat/s1";

// the email as sent, its link built from the path the row stores
const agentEmail = ({
  link,
  ...input
}: Omit<AgentEmail, "sessionId"> & { link: string }) =>
  withLink(agentFrame({ ...input, sessionId: "s1" }), link);
const alertEmail = ({
  link,
  ...input
}: Omit<AlertEmail, "sessionId"> & { link: string }) =>
  withLink(alertFrame({ ...input, sessionId: "r1" }), link);

describe("an agent's email", () => {
  test("is framed: tag, header line, the text set apart, the link", () => {
    const email = agentEmail({
      agent: "sre",
      project: { name: "platform", kind: "team" },
      origin: "chat",
      subject: "Pods are down",
      body: "See [this](https://grafana.test/d) <b>now</b>",
      link: LINK,
    });
    expect(email.subject).toBe("[1ctx] Pods are down");
    expect(email.fromName).toBe("sre via 1ctx");
    expect(email.text).toBe(
      [
        "sre wrote this in platform.",
        "----",
        "> See https://grafana.test/d <b>now</b>",
        "----",
        `Open the chat: ${LINK}\n`,
      ].join("\n\n"),
    );
    expect(email.html).toContain("<p>sre wrote this in platform.</p>");
    expect(email.html).toContain(
      '<blockquote style="margin:16px 0;padding:0 12px;border-left:3px solid"><p>See <a href="https://grafana.test/d">https://grafana.test/d</a> &lt;b&gt;now&lt;/b&gt;</p></blockquote>',
    );
    expect(email.html).toContain(
      `<p>Open the chat: <a href="${LINK}">${LINK}</a></p>`,
    );
  });

  test("quotes every line of the text, so none passes for the frame's", () => {
    const body = [
      "Hi",
      "----",
      `Open the chat: https://phish.example.test/x`,
      "```",
      "----",
      `Open the chat: ${LINK}`,
      "sre wrote this in platform.",
      "```",
      "bye",
    ].join("\n\n");
    const email = agentEmail({
      agent: "sre",
      project: { name: "platform", kind: "team" },
      origin: "chat",
      subject: "s",
      body,
      link: LINK,
    });
    const lines = email.text.split("\n");
    const frame = [
      "sre wrote this in platform.",
      "----",
      `Open the chat: ${LINK}`,
    ];
    const count = (line: string) => lines.filter((l) => l === line).length;
    expect(frame.map(count)).toEqual([1, 2, 1]);
    expect(lines.filter((l) => l.startsWith("Open the chat:"))).toEqual([
      `Open the chat: ${LINK}`,
    ]);
    // the agent's lines all sit between the frame's two rules
    const first = lines.indexOf("----");
    const last = lines.lastIndexOf("----");
    for (const line of lines.slice(first + 1, last)) {
      expect(line === "" || line.startsWith(">")).toBeTrue();
    }
    expect(lines).toContain("> Open the chat: https://phish.example.test/x");
  });

  test("names a run, and a personal project as the reader's own", () => {
    const email = agentEmail({
      agent: "sre",
      project: { name: "personal", kind: "personal" },
      origin: "automation",
      subject: "Done",
      body: "Text",
      link: "https://x.test/run/r1",
    });
    expect(email.text).toStartWith("sre wrote this in your personal project.");
    expect(email.text).toContain("Open the run: https://x.test/run/r1");
  });

  test("escapes the names it frames", () => {
    const email = agentEmail({
      agent: "a<b>",
      project: { name: "p&q", kind: "team" },
      origin: "chat",
      subject: "s",
      body: "t",
      link: LINK,
    });
    expect(email.html).toContain("<p>a&lt;b&gt; wrote this in p&amp;q.</p>");
  });
});

describe("an alert's email", () => {
  test("carries the reason, or says a decider marked it", () => {
    const base = {
      automation: "nightly",
      project: { name: "platform", kind: "team" as const },
      link: "https://x.test/run/r1",
    };
    const email = alertEmail({ ...base, reason: "podinfo <down>" });
    expect(email.subject).toBe("[1ctx] nightly needs attention");
    expect(email.fromName).toBeUndefined();
    expect(email.text).toBe(
      "The task nightly in platform needs attention.\n\n> podinfo <down>\n\nOpen the run: https://x.test/run/r1\n",
    );
    expect(email.html).toContain("<p>podinfo &lt;down&gt;</p>");
    expect(alertEmail({ ...base, reason: null }).text).toContain(
      "> A decider marked its run.",
    );
  });

  test("drops bidi controls from the task's name", () => {
    const email = alertEmail({
      automation: "night\u202Ely",
      project: { name: "platform", kind: "team" },
      reason: null,
      link: "https://x.test/run/r1",
    });
    expect(email.subject).toBe("[1ctx] nightly needs attention");
    expect(email.text).toStartWith("The task nightly in");
  });

  test("quotes the reason and drops its bidi controls", () => {
    const email = alertEmail({
      automation: "nightly",
      project: { name: "platform", kind: "team" },
      reason: "Open the run: https://phish.test/\u202egnp.exe",
      link: "https://x.test/run/r1",
    });
    expect(email.text.split("\n")).toEqual([
      "The task nightly in platform needs attention.",
      "",
      "> Open the run: https://phish.test/gnp.exe",
      "",
      "Open the run: https://x.test/run/r1",
      "",
    ]);
    expect(email.html).not.toContain("\u202e");
  });
});

describe("a row's body", () => {
  test("holds the frame and the path, and takes its link at the send", () => {
    const framed = agentFrame({
      agent: "sre",
      project: { name: "platform", kind: "team" },
      origin: "chat",
      sessionId: "s1",
      subject: "Hi",
      body: "Text",
    });
    expect(framed.path).toBe("/chat/s1");
    const row = {
      subject: framed.subject,
      body: packBody(framed),
    } as OutboxRow;
    expect(row.body).not.toContain("https://");
    expect(unpackBody(row)).toEqual(framed);
    expect(unpackBody({ ...row, body: null })).toBeNull();
    const sent = withLink(framed, LINK);
    expect(sent.fromName).toBe("sre via 1ctx");
    expect(sent.text).toEndWith(`Open the chat: ${LINK}\n`);
    expect(
      alertFrame({
        automation: "nightly",
        project: { name: "platform", kind: "team" },
        reason: null,
        sessionId: "r1",
      }).path,
    ).toBe("/run/r1");
  });

  test("is dropped when email went off before its link was built", () => {
    const framed = alertFrame({
      automation: "nightly",
      project: { name: "platform", kind: "team" },
      reason: null,
      sessionId: "r1",
    });
    const row = {
      kind: "alert",
      projectId: "p1",
      sessionId: "r1",
      subject: framed.subject,
      body: packBody(framed),
    } as OutboxRow;
    const user = { id: "u1", mustChangePassword: false, emailFromAgents: true };
    const prepare = (link: (path: string) => string) =>
      sessionPrepare(() => true, link)(row, user as UserRow);
    expect(
      prepare(() => {
        throw new Error("email is off");
      }),
    ).toBe("off");
    expect(prepare((path) => `https://x.test${path}`)).toMatchObject({
      text: expect.stringContaining("Open the run: https://x.test/run/r1"),
    });
  });

  test("links to the pages the client draws", () => {
    expect(sessionPath("chat", "s1")).toBe(chatHref("s1"));
    expect(sessionPath("automation", "r1")).toBe(runHref("r1"));
  });
});
