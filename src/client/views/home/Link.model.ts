// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words of the page an email links to: what the link does, the
// account it is for, and the one already signed in when that is
// another, since going on replaces it.

import type { LinkPurpose } from "../../../shared/api/access.ts";
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD,
  passwordProblem,
} from "../../../shared/words.ts";

export type LinkWords = {
  title: string;
  line: string;
  button: string;
  busy: string;
  // reset and invite set a password; a sign in link takes none
  password: boolean;
};

export function linkWords(purpose: LinkPurpose, username: string): LinkWords {
  switch (purpose) {
    case "reset":
      return {
        title: "Choose a new password",
        line: `For @${username}. It signs @${username} out everywhere else.`,
        button: "Set password",
        busy: "Setting",
        password: true,
      };
    case "invite":
      return {
        title: "Welcome to 1ctx",
        line: `Choose a password for @${username}.`,
        button: "Set password",
        busy: "Setting",
        password: true,
      };
    case "signin":
      return {
        title: `Sign in as @${username}`,
        line: "The link works once.",
        button: "Sign in",
        busy: "Signing in",
        password: false,
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

export function newPasswordProblem(value: string): string | null {
  const problem = passwordProblem(value);
  if (problem === "short")
    return `The password needs at least ${MIN_PASSWORD} characters`;
  if (problem === "long")
    return `The password needs at most ${MAX_PASSWORD_BYTES} bytes`;
  return null;
}

// a link the server no longer knows is said plainly; any other failure
// is the server's words
export function goneLine(status: number | null): string | null {
  return status === 404
    ? "This link is no longer valid. Ask for a new one from the sign in page."
    : null;
}
