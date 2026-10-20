// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The writes a chat answers with its whole detail, taken as an envelope
// is: a regenerate, a compact and a rename.

import type {
  RegenerateRequest,
  RenameSessionRequest,
  SessionResponse,
} from "../../shared/api/sessions.ts";
import { api } from "./api.ts";
import { carry, changeOf } from "./capabilities.ts";
import { sending } from "./session-start.ts";
import { take } from "./sessions.ts";

// a send of any kind answers the detail; the flips the person made ride
// on the two kinds that take them and are forgotten once taken
async function post(
  id: string,
  path: string,
  body?: RegenerateRequest,
): Promise<void> {
  sending.value = true;
  try {
    const at = `/api/sessions/${encodeURIComponent(id)}/${path}`;
    take(
      await carry(id, body ?? {}, () => api<SessionResponse>(at, "POST", body)),
    );
  } finally {
    sending.value = false;
  }
}

// the last turn goes and its user message is sent again
export const regenerateSession = (id: string): Promise<void> =>
  post(id, "regenerate", changeOf(id));

// a summary round on its own; the next reply starts from the summary
export const compactSession = (id: string) => post(id, "compact");

// a rename is not a send: it goes under a reply too, and the composer
// stays free while it is on its way
export async function renameSession(id: string, title: string): Promise<void> {
  const body: RenameSessionRequest = { title };
  const detail = await api<SessionResponse>(
    `/api/sessions/${encodeURIComponent(id)}`,
    "PATCH",
    body,
  );
  take(detail);
}
