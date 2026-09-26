// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Archive by hand: the chat becomes read-only for good. The answer is
// empty, and who archived it and until when are the detail's, so the
// chat on screen is read again unless the socket's envelope already
// did.

import { api } from "./api.ts";
import { loadSession, session } from "./sessions.ts";

export async function archiveSession(id: string): Promise<void> {
  await api(`/api/sessions/${encodeURIComponent(id)}/archive`, "POST");
  const held = session.value;
  if (held?.session.id === id && held.session.archived === null) {
    await loadSession(id);
  }
}
