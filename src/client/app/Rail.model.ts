// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SessionDetail } from "../../shared/contracts/session.ts";

// the project a page is in: its own pages, or the chat's
export function projectHere(
  pathname: string,
  chat: SessionDetail | null,
): string | null {
  const page = /^\/projects\/([^/]+)(\/|$)/.exec(pathname);
  if (page !== null) return decodeURIComponent(page[1]);
  const open = /^\/chat\/([^/]+)$/.exec(pathname);
  if (open !== null && chat?.session.id === decodeURIComponent(open[1])) {
    return chat.session.projectId;
  }
  return null;
}
