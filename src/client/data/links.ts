// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The links an email carries: asking for one from the sign-in page, and
// the link page's read and its one action. The read changes nothing on
// the server, so a email scanner that opens the page does no harm.

import { signal } from "@preact/signals";
import type {
  LinkResponse,
  LoginResponse,
  UseLinkRequest,
} from "../../shared/api/access.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { setMe } from "./me.ts";

// the link on screen: its token and what the server said of it
export const link = signal<{ token: string; value: LinkResponse } | null>(null);
export const linkError = signal<Failure | null>(null);

let turn = 0;

export async function loadLink(token: string): Promise<void> {
  const mine = ++turn;
  linkError.value = null;
  if (link.value?.token !== token) link.value = null;
  try {
    const value = await api<LinkResponse>(
      `/api/links/${encodeURIComponent(token)}`,
    );
    if (turn === mine) link.value = { token, value };
  } catch (err) {
    if (turn === mine) linkError.value = failure(err);
  }
}

// signs this browser in as the link's user, in place of any other
export async function applyLink(
  token: string,
  body: UseLinkRequest,
): Promise<void> {
  const { user } = await api<LoginResponse>(
    `/api/links/${encodeURIComponent(token)}`,
    "POST",
    body,
  );
  turn++;
  link.value = null;
  setMe(user);
}

// answered the same whoever it names, so there is nothing to read back
export async function askLink(
  kind: "forgot" | "link",
  username: string,
): Promise<void> {
  await api(`/api/login/${kind}`, "POST", { username });
}
