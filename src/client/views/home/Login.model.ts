// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sign-in page's email links: the server answers the same whoever
// was named, so the page says the same too.

export type Ask = "forgot" | "link";

export function askProblem(name: string): string | null {
  return name.trim() === "" ? "Enter your username or email first." : null;
}

export function askedLine(kind: Ask): string {
  return kind === "forgot"
    ? "If the account has an email, a reset link is on its way."
    : "If the account has an email, a sign in link is on its way.";
}
