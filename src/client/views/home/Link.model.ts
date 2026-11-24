// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words of the page an email links to: what the link does, the
// account it is for, and the one already signed in when that is
// another, since going on replaces it.

import type { LinkPurpose } from "../../../shared/api/access.ts";

export type LinkWords = {
  title: string;
  line: string;
  button: string;
  busy: string;
};

export function linkWords(purpose: LinkPurpose, username: string): LinkWords {
  switch (purpose) {
    case "invite":
      return {
        title: "Welcome to 1ctx",
        line: `Sign in as @${username}. The link works once.`,
        button: "Sign in",
        busy: "Signing in",
      };
    case "signin":
      return {
        title: `Sign in as @${username}`,
        line: "The link works once.",
        button: "Sign in",
        busy: "Signing in",
      };
  }
}

// null when nobody is signed in here, or the link's own user is
export function otherAccount(
  signedIn: string | null,
  username: string,
): string | null {
  if (signedIn === null || signedIn === username) return null;
  return `You are signed in as @${signedIn}. Going on signs you in as @${username} instead.`;
}

// a link the server no longer knows, said plainly
export const GONE_LINE =
  "This link is no longer valid. Ask for a new one from the sign in page.";
