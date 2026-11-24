// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sign-in page's email link: the server answers the same whoever
// was named, so the page says the same too.

export function askProblem(name: string): string | null {
  return name.trim() === "" ? "Enter your username or email first." : null;
}

export const ASKED_LINE =
  "If the account has an email, a sign in link is on its way.";
