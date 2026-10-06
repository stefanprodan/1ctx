// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The frame around what an agent wrote, and an automation's alert: a
// subject under the instance's tag, a fixed line saying who wrote it
// where, the agent's text set apart, and one trusted link back. Both
// are built when the row is queued and stored with it, so the email
// says what the agent wrote then, whatever is renamed later. The link
// is stored as a path and built at the send, from the public address
// as it is then.

import { stripBidi } from "../../shared/words.ts";
import { escapeHtml, renderEmailMarkdown } from "../render/index.ts";
import type { EmailContent, Prepare } from "./sender.ts";
import type { OutboxRow } from "./store.ts";

export const SUBJECT_TAG = "[1ctx] ";

// where a session opens in the app, as the client's chatHref and
// runHref build it
export const sessionPath = (
  origin: "chat" | "automation",
  sessionId: string,
): string =>
  `/${origin === "automation" ? "run" : "chat"}/${encodeURIComponent(sessionId)}`;

// an email framed but for its link: the text and the HTML before the
// closing line, its words and the path the link opens
export type Framed = {
  subject: string;
  fromName?: string;
  text: string;
  html: string;
  foot: string;
  path: string;
};

// what a row stores in its body: the frame but its subject
type Stored = Omit<Framed, "subject">;

const page = (parts: string[]) =>
  `<!doctype html><html><body>${parts.join("")}</body></html>`;

const linkHtml = (words: string, link: string) =>
  `<p>${escapeHtml(words)} <a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`;

// the agent's text in the plain part, every line quoted as the HTML's
// blockquote sets it apart, so none can pass for a line of the frame
const quoted = (text: string) =>
  text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

// the project as the recipient knows it: a personal project is theirs
const placeOf = (project: { name: string; kind: "personal" | "team" }) =>
  project.kind === "personal" ? "your personal project" : project.name;

// the email with its one trusted link, a full address
export function withLink(framed: Framed, link: string): EmailContent {
  return {
    subject: framed.subject,
    ...(framed.fromName === undefined ? {} : { fromName: framed.fromName }),
    text: `${framed.text}${framed.foot} ${link}\n`,
    html: page([framed.html, linkHtml(framed.foot, link)]),
  };
}

export type AgentEmail = {
  agent: string;
  project: { name: string; kind: "personal" | "team" };
  origin: "chat" | "automation";
  sessionId: string;
  subject: string;
  body: string;
};

export function agentEmail(input: AgentEmail): Framed {
  const where = input.origin === "automation" ? "run" : "chat";
  const head = `${input.agent} wrote this in ${placeOf(input.project)}.`;
  const body = renderEmailMarkdown(input.body);
  return {
    subject: `${SUBJECT_TAG}${input.subject}`,
    fromName: `${input.agent} via 1ctx`,
    text: `${head}\n\n----\n\n${quoted(body.text)}\n\n----\n\n`,
    html: [
      `<p>${escapeHtml(head)}</p>`,
      `<blockquote style="margin:16px 0;padding:0 12px;border-left:3px solid">${body.html}</blockquote>`,
    ].join(""),
    foot: `Open the ${where}:`,
    path: sessionPath(input.origin, input.sessionId),
  };
}

export type AlertEmail = {
  automation: string;
  project: { name: string; kind: "personal" | "team" };
  // the run's reason, null for a decider's mark, which gives none
  reason: string | null;
  sessionId: string;
};

export function alertEmail(input: AlertEmail): Framed {
  // a name with a direction character would fail the subject check and
  // lose the email
  const name = stripBidi(input.automation);
  const head = `The task ${name} in ${placeOf(input.project)} needs attention.`;
  const why =
    input.reason === null
      ? "A decider marked its run."
      : stripBidi(input.reason);
  return {
    subject: `${SUBJECT_TAG}${name} needs attention`,
    text: `${head}\n\n${quoted(why)}\n\n`,
    html: [
      `<p>${escapeHtml(head)}</p>`,
      `<blockquote style="margin:16px 0;padding:0 12px;border-left:3px solid"><p>${escapeHtml(why)}</p></blockquote>`,
    ].join(""),
    foot: "Open the run:",
    path: sessionPath("automation", input.sessionId),
  };
}

// the body column of a row that holds its email
export function packBody(framed: Framed): string {
  const { subject: _, ...stored } = framed;
  return JSON.stringify(stored satisfies Stored);
}

// the email a row holds, null when it holds none
export function unpackBody(row: OutboxRow): Framed | null {
  if (row.subject === null || row.body === null) return null;
  return { subject: row.subject, ...(JSON.parse(row.body) as Stored) };
}

// the sender's last word on an email about a chat or run: what made
// the user a recipient still holds, and the row holds its email; the
// link is built now, from the public address of the send
export function sessionPrepare(
  canOpen: (userId: string, projectId: string) => boolean,
  link: (path: string) => string,
): Prepare {
  return (row, user) => {
    if (row.sessionId === null) return "deleted";
    if (row.projectId === null || !canOpen(user.id, row.projectId)) {
      return "no-access";
    }
    if (user.mustChangePassword) return "no-access";
    if (!user.emailFromAgents) return "opted-out";
    const framed = unpackBody(row);
    if (framed === null) throw new Error(`an ${row.kind} row has no text`);
    return withLink(framed, link(framed.path));
  };
}
