// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a waiting row's actions do in a chat. Edit and Send again are
// refused while an edit is open, so its text is never lost. Send again
// deletes the row first and hands its text to the composer only once
// the delete landed. Remove of the row open for an edit closes the edit
// with its own words once the row went. A row a socket frame carried
// cut is read whole first.

import type { QueuedMessage } from "../../../shared/contracts/session.ts";
import {
  EDIT_OPEN,
  EDIT_REMOVED,
  editing,
  editOpen,
  handOver,
  removing,
} from "../../composer/handoff.ts";
import { readQueued, removeQueued } from "../../data/queued.ts";
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
      const whole = await readQueued(sessionId, row);
      refuseOpen();
      handOver({ kind: "edit", sessionId, row: whole });
    },
    onRemove: async (row: QueuedMessage) => {
      const open =
        editing.value?.sessionId === sessionId && editing.value.id === row.id;
      // marked before the delete is sent, so the row gone from the queue
      // never ends the edit with words for a row gone elsewhere
      if (open) removing.add(row.id);
      try {
        await removeQueued(sessionId, row);
        if (open) {
          handOver({
            kind: "close",
            sessionId,
            id: row.id,
            words: EDIT_REMOVED,
          });
        }
      } finally {
        removing.delete(row.id);
      }
    },
    onSendAgain: archived
      ? undefined
      : async (row: QueuedMessage) => {
          refuseOpen();
          const { text } = await readQueued(sessionId, row);
          await removeQueued(sessionId, row);
          handOver({ kind: "again", sessionId, text });
        },
  };
}
