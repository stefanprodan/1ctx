// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The frame around what an agent wrote, and an automation's alert: a
// subject under the instance's tag, a fixed line saying who wrote it
// where, the agent's text set apart, and one trusted link back. Both
// are built when the row is queued and stored with it, so the email
// says what the agent wrote then, whatever is renamed later.

import { escapeHtml, renderEmailMarkdown } from "../render/index.ts";
import type { EmailContent } from "./sender.ts";
import type { OutboxRow } from "./store.ts";

export const SUBJECT_TAG = "[1ctx] ";

// where a session opens in the app, as the client's chatHref and
// runHref build it
export const sessionPath = (
  origin: "chat" | "automation",
  sessionId: string,
): string =>
  `/${origin === "automation" ? "run" : "chat"}/${encodeURIComponent(sessionId)}`;

// what a row stores in its body: the text and the HTML, and the From
// name an agent's email carries
type Stored = { text: string; html: string; fromName?: string };

const page = (parts: string[]) =>
  `<!doctype html><html><body>${parts.join("")}</body></html>`;

const linkHtml = (words: string, link: string) =>
  `<p>${escapeHtml(words)} <a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`;

// the project as the recipient knows it: a personal project is theirs
const placeOf = (project: { name: string; kind: "personal" | "team" }) =>
  project.kind === "personal" ? "your personal project" : project.name;

export type AgentEmail = {
  agent: string;
  project: { name: string; kind: "personal" | "team" };
  origin: "chat" | "automation";
  subject: string;
  body: string;
  // the full address of the chat or run
  link: string;
};

export function agentEmail(input: AgentEmail): EmailContent {
  const where = input.origin === "automation" ? "run" : "chat";
  const head = `${input.agent} wrote this in ${placeOf(input.project)}.`;
  const foot = `Open the ${where}:`;
  const body = renderEmailMarkdown(input.body);
  return {
    subject: `${SUBJECT_TAG}${input.subject}`,
    fromName: `${input.agent} via 1ctx`,
    text: `${head}\n\n----\n\n${body.text}\n\n----\n\n${foot} ${input.link}\n`,
    html: page([
      `<p>${escapeHtml(head)}</p>`,
      `<blockquote style="margin:16px 0;padding:0 12px;border-left:3px solid">${body.html}</blockquote>`,
      linkHtml(foot, input.link),
    ]),
  };
}

export type AlertEmail = {
  automation: string;
  project: { name: string; kind: "personal" | "team" };
  // the run's reason, null for a decider's mark, which gives none
  reason: string | null;
  link: string;
};

export function alertEmail(input: AlertEmail): EmailContent {
  const head = `The task ${input.automation} in ${placeOf(input.project)} needs attention.`;
  const why = input.reason ?? "A decider marked its run.";
  const foot = "Open the run:";
  return {
    subject: `${SUBJECT_TAG}${input.automation} needs attention`,
    text: `${head}\n\n${why}\n\n${foot} ${input.link}\n`,
    html: page([
      `<p>${escapeHtml(head)}</p>`,
      `<blockquote style="margin:16px 0;padding:0 12px;border-left:3px solid"><p>${escapeHtml(why)}</p></blockquote>`,
      linkHtml(foot, input.link),
    ]),
  };
}

// the body column of a row that holds its email
export function packBody(content: EmailContent): string {
  const stored: Stored = { text: content.text, html: content.html ?? "" };
  if (content.fromName !== undefined) stored.fromName = content.fromName;
  return JSON.stringify(stored);
}

// the email a row holds, null when it holds none
export function unpackBody(row: OutboxRow): EmailContent | null {
  if (row.subject === null || row.body === null) return null;
  const stored = JSON.parse(row.body) as Stored;
  return {
    subject: row.subject,
    text: stored.text,
    html: stored.html,
    ...(stored.fromName === undefined ? {} : { fromName: stored.fromName }),
  };
}
