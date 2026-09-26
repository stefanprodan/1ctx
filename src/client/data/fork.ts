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
  ForkSessionResponse,
} from "../../shared/api/sessions.ts";
import { navigate } from "../app/router.ts";
import { draftKey, writeDraft } from "../composer/draft.ts";
import { chatHref } from "../lib/hrefs.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { session } from "./sessions.ts";
import { loadUploads } from "./uploads.ts";

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
    const detail = await api<ForkSessionResponse>(
      `/api/sessions/${encodeURIComponent(id)}/fork`,
      "POST",
      body,
    );
    if (owner === null || me.value?.id !== owner) return;
    // the draft is kept even when the person has moved on: the server
    // staged the turn's files again, and the new chat is where they wait
    if (draft !== null) {
      // the unsent turn's files were staged again for the fork: the draft
      // names them by the items the message carried, in their order
      const projectId = detail.session.projectId;
      writeDraft(draftKey(owner, { sessionId: detail.session.id }), {
        text: draft,
        uploads: detail.draftUploads.map((uploadId, index) => ({
          projectId,
          id: uploadId,
          name: row?.uploads?.[index]?.name ?? "a file",
        })),
      });
      if (detail.draftUploads.length > 0) void loadUploads(projectId);
    }
    // the page moves only for the chat they asked from, and only when
    // no later fork superseded it
    if (mine !== turn || session.value?.session.id !== id) return;
    navigate(chatHref(detail.session.id));
  } finally {
    if (mine === turn) forking.value = false;
  }
}
