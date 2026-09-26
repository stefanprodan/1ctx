// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The addresses of a user's page, an agent's page, a chat, an
// automation and a chat's download, so every link to them is built one
// way.

import { browserZone } from "./zone.ts";

export function userHref(username: string): string {
  return `/users/${encodeURIComponent(username)}`;
}

export function agentHref(name: string): string {
  return `/agents/${encodeURIComponent(name)}`;
}

export function chatHref(id: string): string {
  return `/chat/${encodeURIComponent(id)}`;
}

export function automationHref(id: string): string {
  return `/automations/${encodeURIComponent(id)}`;
}

// the chat as a Markdown file: a link the browser saves, never a fetch,
// so the cookie and the server's filename do the work. The times are
// in the browser's zone
export const markdownHref = (id: string): string =>
  `/api/sessions/${encodeURIComponent(id)}/markdown?tz=${encodeURIComponent(
    browserZone(),
  )}`;
