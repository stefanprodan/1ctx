// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sign-in's posts: a wrong key, code or passkey ends no login, so
// they skip api()'s 401 hook, and their failures say the sign-in's own
// words for the status, never the body's.

import { ApiError } from "./api.ts";

// the words for a sign-in post's failure; wrong is the 401's
export function signInWords(status: number, wrong: string): string {
  if (status === 0) return "the server did not answer";
  if (status === 401) return wrong;
  if (status === 400) return "email is an email address";
  // the same-origin check: a post from another site's page
  if (status === 403) return "not sent from this server's pages";
  // only the email routes answer 404, while email is off
  if (status === 404) return "email is off";
  if (status === 429) return "too many tries; wait a minute";
  if (status >= 500) return "the server failed";
  return "refused";
}

// the answer's JSON, or null when it has none
export async function signInPost(
  path: string,
  body: unknown,
  wrong: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, signInWords(0, wrong));
  }
  if (!res.ok) {
    // the words stay the page's own; a code, such as an unknown
    // passkey's, still reaches the caller
    const body: unknown = await res.json().catch(() => null);
    throw new ApiError(res.status, signInWords(res.status, wrong), body);
  }
  return await res.json().catch(() => null);
}
