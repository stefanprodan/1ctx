// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// email_user: an agent emails users who can already open its chat or
// run, by username, never an address, so no email tells anyone what
// they could not read in the app. The tool checks the call's shape;
// the port checks the recipients and the caps and queues the emails.

import { EMAIL_TOOL, hasLineBreak } from "../../../shared/words.ts";
import { badSubject } from "../../email/rules.ts";
import { fields } from "../../lib/body.ts";
import type { Tool, ToolContext } from "../types.ts";

export const MAX_EMAIL_TO = 5;
export const MAX_EMAIL_SUBJECT = 200;
export const MAX_EMAIL_BODY = 20 * 1024;
// constants, not limits rows: an editable cap waits until one is needed
export const EMAILS_PER_SEND = 5;
export const EMAILS_PER_PROJECT_DAY = 50;

export type EmailRequest = { to: string[]; subject: string; body: string };

// the send's chat or run, as the tool context names it
export type EmailActor = NonNullable<ToolContext["actor"]>;

export type AgentEmailPort = {
  // the answer the model reads; a throw is a refusal it reads
  email(actor: EmailActor, request: EmailRequest): string;
};

export const EMAIL_DESCRIPTION =
  "Email users who can open this chat or run, by username. " +
  "The email shows your name, the project and a link back here. " +
  "A user who has not turned on email from agents is refused. " +
  "Call it only when the user or the task asks for an email. " +
  `At most ${EMAILS_PER_SEND} emails per turn or run, and ${EMAILS_PER_PROJECT_DAY} per project a day.`;

const bytes = (value: string) => new TextEncoder().encode(value).length;

// the call's arguments, or the words the model reads to fix them
export function parseEmailRequest(args: Record<string, unknown>): EmailRequest {
  const { to, subject, body } = fields(args, ["to", "subject", "body"]);
  if (
    !Array.isArray(to) ||
    to.length === 0 ||
    to.length > MAX_EMAIL_TO ||
    !to.every((name) => typeof name === "string" && name.trim() !== "")
  ) {
    throw new Error(`to must list 1 to ${MAX_EMAIL_TO} usernames`);
  }
  if (
    typeof subject !== "string" ||
    subject.trim() === "" ||
    [...subject].length > MAX_EMAIL_SUBJECT ||
    hasLineBreak(subject)
  ) {
    throw new Error(
      `subject must be one line of 1 to ${MAX_EMAIL_SUBJECT} characters`,
    );
  }
  // the outbox refuses the same, too late for the model to read why
  if (badSubject(subject)) {
    throw new Error(
      "subject must be plain text, with no tab, control or direction characters",
    );
  }
  if (typeof body !== "string" || body.trim() === "") {
    throw new Error("body must be non-empty Markdown");
  }
  if (bytes(body) > MAX_EMAIL_BODY) {
    throw new Error(`body must be at most ${MAX_EMAIL_BODY / 1024} KB`);
  }
  // one email per user, however often the call names them
  const names = [...new Set(to.map((name: string) => name.trim()))];
  return { to: names, subject: subject.trim(), body };
}

export function makeEmailTool(port: AgentEmailPort | null): Tool {
  return {
    name: EMAIL_TOOL,
    description: EMAIL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "array",
          description: "Usernames, without the @.",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_EMAIL_TO,
        },
        subject: {
          type: "string",
          description: "One line.",
          minLength: 1,
          maxLength: MAX_EMAIL_SUBJECT,
        },
        body: {
          type: "string",
          description: `Markdown, at most ${MAX_EMAIL_BODY / 1024} KB. Links show their full address; images are dropped.`,
          minLength: 1,
        },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      ctx.signal.throwIfAborted();
      const request = parseEmailRequest(args);
      if (port === null || ctx.actor === null) {
        throw new Error("email is not available here");
      }
      return port.email(ctx.actor, request);
    },
  };
}
