// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat's first message and a stop: neither reads the chat on screen,
// so they sit apart from the entity that holds it.

import { signal } from "@preact/signals";
import type {
  CreateSessionRequest,
  SessionResponse,
} from "../../shared/api/sessions.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import { navigate } from "../app/router.ts";
import { api } from "./api.ts";
import { carry, changeOf } from "./capabilities.ts";

// a send the composer asked for and the server has not answered
export const sending = signal(false);

export async function createSession(
  body: CreateSessionRequest,
): Promise<SessionDetail> {
  sending.value = true;
  try {
    // the flips made before the chat existed go with its first message
    const sent = changeOf(null);
    const detail = await carry(null, sent, () =>
      api<SessionResponse>("/api/sessions", "POST", { ...body, ...sent }),
    );
    navigate(`/chat/${detail.session.id}`);
    return detail;
  } finally {
    sending.value = false;
  }
}

// the answer is empty: the end of the send arrives as an envelope
export async function stopSession(id: string): Promise<void> {
  await api(`/api/sessions/${encodeURIComponent(id)}/stop`, "POST");
}
