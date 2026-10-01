// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home's Not sent card, between the composer and the feed, only while
// the user has a message that never started: a feed line per message
// leading to its chat, and Discard all in the head, which asks nothing.

import { useEffect } from "preact/hooks";
import { discardNotSent, notSent, watchNotSent } from "../../data/not-sent.ts";
import { NotSentRow } from "../../feed/NotSentRow.tsx";
import { useAction } from "../../lib/save.ts";
import { RowsAction, RowsBlock, RowsCard } from "../../ui/Rows.tsx";

export function NotSent({ now }: { now: number }) {
  useEffect(() => watchNotSent(), []);
  const discard = useAction();
  const rows = notSent.value;
  if (rows === null || rows.length === 0) return null;
  return (
    <RowsCard
      label="Not sent"
      count={String(rows.length)}
      action={
        <RowsAction
          label="Discard all"
          disabled={discard.busy.value}
          onClick={() => void discard.run(discardNotSent)}
        />
      }
    >
      {rows.map((row) => (
        <NotSentRow key={row.id} row={row} now={now} />
      ))}
      {discard.failure.value !== null && (
        <RowsBlock>
          <p class="notice-failed" role="alert">
            {discard.failure.value}
          </p>
        </RowsBlock>
      )}
    </RowsCard>
  );
}
