// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A fork: a new chat from the rows up to a turn, on the picked agent.
// The page moves to it and its load fetches the detail. The route takes
// a user message too, whose text then becomes the fork's draft; the
// page offers the action on answers alone. The turn is read before the
// call, since the answer may land after the user left.

import { effect, signal } from "@preact/signals";
import type {
  ForkSessionRequest,
  SessionResponse,
} from "../../shared/api/sessions.ts";
import { navigate } from "../app/router.ts";
import { draftKey, writeDraft } from "../composer/draft.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { session } from "./sessions.ts";

// a fork asked for and not answered: every fork button waits
export const forking = signal(false);
// the fork last asked for; an older answer neither navigates nor frees
// the buttons
let turn = 0;

effect(() => {
  if (me.value === null) forking.value = false;
});

export async function forkSession(
  id: string,
  messageId: string,
  agentId: string,
  title?: string,
): Promise<void> {
  const row = session.value?.messages.find((m) => m.id === messageId);
  const draft = row?.kind === "user" ? row.content : null;
  const owner = me.value?.id ?? null;
  const mine = ++turn;
  forking.value = true;
  try {
    const body: ForkSessionRequest = {
      messageId,
      agentId,
      ...(title === undefined ? {} : { title }),
    };
    const detail = await api<SessionResponse>(
      `/api/sessions/${encodeURIComponent(id)}/fork`,
      "POST",
      body,
    );
    // the answer is acted on only for the person who asked, on the
    // chat they asked from, and only when no later fork superseded it
    if (
      mine !== turn ||
      owner === null ||
      me.value?.id !== owner ||
      session.value?.session.id !== id
    ) {
      return;
    }
    if (draft !== null) {
      writeDraft(draftKey({ sessionId: detail.session.id }), draft);
    }
    navigate(`/chat/${detail.session.id}`);
  } finally {
    if (mine === turn) forking.value = false;
  }
}
