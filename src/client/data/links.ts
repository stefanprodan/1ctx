// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Signing in by email from the sign-in page: asking for a code, and
// the code. The ask sets the browser's challenge, a cookie the code is
// only tried beside; same-origin fetches carry it. The link an email
// carries opens a page the server draws.

import type {
  CodeRequest,
  CodeResponse,
  LinkAskRequest,
} from "../../shared/api/access.ts";
import { api } from "./api.ts";
import { loadDictationOn, setMe } from "./me.ts";

// answered the same whoever it names, so there is nothing to read back
export async function askLink(email: string): Promise<void> {
  const body: LinkAskRequest = { email };
  await api("/api/login/link", "POST", body);
}

// signs this browser in, in place of any other; the landing to go to
export async function sendCode(body: CodeRequest): Promise<string> {
  const { user, landing } = await api<CodeResponse>(
    "/api/login/code",
    "POST",
    body,
  );
  setMe(user);
  void loadDictationOn();
  return landing;
}
