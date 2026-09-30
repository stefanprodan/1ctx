// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The messages that wait under the last turn, oldest first, each drawn
// as a user message is: who wrote it and when, the text in a card, and
// under it where it stands. Its author alone gets the actions: Edit and
// Remove while it waits, Send again and Discard once it was not sent.
// Another member sees the row without them; a message that was not sent
// shows to its author alone. Nothing asks first.

import type { QueuedMessage } from "../../shared/contracts/session.ts";
import { clock, initials, plural } from "../lib/format.ts";
import { userHref } from "../lib/hrefs.ts";
import { Icon } from "../lib/icons.tsx";
import { useAction } from "../lib/save.ts";
import { queuedLine } from "./Queued.words.ts";

export type QueueProps = {
  rows: readonly QueuedMessage[];
  // the chat's turn runs, so a queued row starts when it ends
  running: boolean;
  userId: string | null;
  // the row open in the composer, whose Edit is gone
  editing: string | null;
  authorOf: (userId: string | null) => {
    name: string;
    username: string | null;
  };
  onEdit: (row: QueuedMessage) => Promise<void>;
  onRemove: (row: QueuedMessage) => Promise<void>;
  // absent where no composer takes the text, as in an archived chat
  onSendAgain?: (row: QueuedMessage) => Promise<void>;
};

export function QueuedRows(props: QueueProps) {
  return (
    <>
      {props.rows.map((row) => (
        <QueuedRow key={row.id} row={row} {...props} />
      ))}
    </>
  );
}

function QueuedRow({
  row,
  running,
  userId,
  editing,
  authorOf,
  onEdit,
  onRemove,
  onSendAgain,
}: QueueProps & { row: QueuedMessage }) {
  const action = useAction();
  const known = authorOf(row.author.id);
  // a member the page does not know by name keeps their username
  const username = known.username ?? row.author.username;
  const name = known.username === null ? username : known.name;
  const mine = userId !== null && row.author.id === userId;
  const waits = row.state === "queued";
  const busy = action.busy.value;
  return (
    <div class="transcript-user transcript-queued">
      <div class="transcript-author">
        <span class="avatar avatar-24">{initials(name)}</span>
        <a
          class="transcript-name transcript-name-link"
          href={userHref(username)}
        >
          {name}
        </a>
        <span class="transcript-when">{clock(row.queuedAt)}</span>
      </div>
      <div class="card transcript-card transcript-queued-card">
        {row.text}
        {row.uploads > 0 && (
          <span class="transcript-queued-files">
            <Icon name="clip" size={12} />
            {plural(row.uploads, "file")}
          </span>
        )}
      </div>
      <div class="transcript-queued-foot">
        <span
          class={waits ? "transcript-queued-line" : "transcript-queued-bad"}
        >
          {queuedLine(row, running)}
        </span>
        {mine && (
          <span class="transcript-queued-acts">
            {waits && editing !== row.id && (
              <button
                type="button"
                class="btn-text"
                disabled={busy}
                onClick={() => void action.run(() => onEdit(row))}
              >
                Edit
              </button>
            )}
            {!waits && onSendAgain !== undefined && (
              <button
                type="button"
                class="btn-text"
                disabled={busy}
                onClick={() => void action.run(() => onSendAgain(row))}
              >
                Send again
              </button>
            )}
            <button
              type="button"
              class="btn-text"
              disabled={busy}
              onClick={() => void action.run(() => onRemove(row))}
            >
              {waits ? "Remove" : "Discard"}
            </button>
          </span>
        )}
      </div>
      {action.failure.value !== null && (
        <p class="notice-failed transcript-failure" role="alert">
          {action.failure.value}
        </p>
      )}
    </div>
  );
}
