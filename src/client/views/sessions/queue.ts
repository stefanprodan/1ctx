// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a waiting row's actions do in a chat. Edit and Send again are
// refused while an edit is open, so its text is never lost. Send again
// deletes the row first and hands its text to the composer only once
// the delete landed. Remove of the row open for an edit closes the edit
// with its own words once the row went.

import type { QueuedMessage } from "../../../shared/contracts/session.ts";
import {
  EDIT_OPEN,
  EDIT_REMOVED,
  editing,
  editOpen,
  handOver,
} from "../../composer/handoff.ts";
import { removeQueued } from "../../data/queued.ts";
import type { QueueProps } from "../../transcript/Queued.tsx";

export function queueActions(
  sessionId: string,
  archived: boolean,
): Pick<QueueProps, "editing" | "onEdit" | "onRemove" | "onSendAgain"> {
  const refuseOpen = () => {
    if (editOpen(sessionId)) throw new Error(EDIT_OPEN);
  };
  return {
    editing: editing.value?.sessionId === sessionId ? editing.value.id : null,
    onEdit: async (row: QueuedMessage) => {
      refuseOpen();
      handOver({ kind: "edit", sessionId, row });
    },
    onRemove: async (row: QueuedMessage) => {
      await removeQueued(sessionId, row);
      if (
        editing.value?.sessionId === sessionId &&
        editing.value.id === row.id
      ) {
        handOver({ kind: "close", sessionId, id: row.id, words: EDIT_REMOVED });
      }
    },
    onSendAgain: archived
      ? undefined
      : async (row: QueuedMessage) => {
          refuseOpen();
          await removeQueued(sessionId, row);
          handOver({ kind: "again", sessionId, text: row.text });
        },
  };
}
