// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sign-in page's email code: the server answers the same whoever
// was named, so the page says the same too.

export function askProblem(email: string): string | null {
  return email.trim() === "" ? "Enter your email first." : null;
}

export function codeProblem(code: string): string | null {
  return /^\d{6}$/.test(code.trim()) ? null : "Enter the six digits.";
}

export const ASKED_LINE =
  "If the address has an account, a code and a link are on their way.";
