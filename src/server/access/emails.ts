// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words of the account emails: a link email, built when it is
// sent, and the security notice, built when it is queued. Plain text
// with the same paragraphs as simple HTML. Nothing a user typed reaches
// a subject; the names in the text are the admin's, escaped in HTML.

import { isIP } from "node:net";
import type { LinkPurpose } from "../../shared/api/access.ts";
import { DAY_MS, MINUTE_MS, zoneOrUtc } from "../lib/clock.ts";
import { escapeHtml } from "../render/index.ts";

export const LINK_TTL_MS: Record<LinkPurpose, number> = {
  signin: 15 * MINUTE_MS,
  invite: 7 * DAY_MS,
};

export type Content = { subject: string; text: string; html: string };

type Who = { username: string; fullName: string };

// a paragraph is a string; a link is its own paragraph
type Para = string | { link: string };

const page = (paras: string[]) =>
  `<!doctype html><html><body>${paras.join("")}</body></html>`;

function content(subject: string, paras: Para[]): Content {
  const text = paras.map((p) => (typeof p === "string" ? p : p.link));
  const html = paras.map((p) =>
    typeof p === "string"
      ? `<p>${escapeHtml(p)}</p>`
      : `<p><a href="${escapeHtml(p.link)}">${escapeHtml(p.link)}</a></p>`,
  );
  return { subject, text: `${text.join("\n\n")}\n`, html: page(html) };
}

// the HTML of a stored text with no link, its paragraphs as they were
export function htmlOf(text: string): string {
  return page(
    text
      .trim()
      .split("\n\n")
      .map((p) => `<p>${escapeHtml(p)}</p>`),
  );
}

export function linkEmail(
  purpose: LinkPurpose,
  user: Who,
  link: string,
): Content {
  const hi = `Hi ${user.fullName},`;
  switch (purpose) {
    case "signin":
      return content("Sign in to 1ctx", [
        hi,
        `Open this link within 15 minutes to sign in as @${user.username}.`,
        { link },
        "If you did not ask for it, ignore this email.",
      ]);
    case "invite":
      return content("You are invited to 1ctx", [
        hi,
        `An admin made you an account, @${user.username}. Open this link within 7 days to sign in.`,
        { link },
      ]);
  }
}

// what happened to the account: a sign in by link
export type NoticeEvent = "signin";

const NOTICE: Record<NoticeEvent, { subject: string; what: string }> = {
  signin: {
    subject: "New sign in to 1ctx",
    what: "You signed in by email link",
  },
};

// the time in the user's own zone, named, so it reads the same wherever
// the email is opened; built from parts, since ICU builds join date and
// time with "at" on one system and a comma on another
export function noticeTime(at: number, tz: string): string {
  const zone = zoneOrUtc(tz);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")} at ${part("hour")}:${part("minute")} (${zone})`;
}

export function noticeEmail(
  event: NoticeEvent,
  user: Who & { tz: string },
  at: number,
  address: string,
): Content {
  const { subject, what } = NOTICE[event];
  const when = noticeTime(at, user.tz);
  // a proxy's header is not ours to repeat unless it is an address
  const from = isIP(address) === 0 ? "an unknown address" : address;
  return content(subject, [
    `Hi ${user.fullName},`,
    `${what} on ${when} from ${from}.`,
    "If this was not you, tell your admin.",
  ]);
}
