// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Sandbox page's list of the sandboxes the instance holds, stuck
// deletes named.

import type { LeaseRow } from "../../../shared/contracts/sandbox.ts";
import { useNow } from "../../lib/now.ts";
import {
  RowsFailed,
  RowsLine,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { leaseAge, leaseSub, leaseWord, stuckLine } from "./Sandbox.model.ts";

export function Leases({
  rows,
  failed,
  on,
}: {
  rows: LeaseRow[] | null;
  failed: boolean;
  on: boolean;
}) {
  const now = useNow(30_000);
  return (
    <Setting
      list
      title="Sandboxes"
      count={rows === null ? undefined : String(rows.length)}
      line="What the gateway runs for this instance, oldest first."
    >
      {rows === null ? (
        failed ? (
          <RowsFailed
            failure={{
              words: "The sandboxes did not load.",
              status: null,
            }}
          />
        ) : (
          <RowsNote>Loading the sandboxes.</RowsNote>
        )
      ) : (
        <>
          {failed && (
            <RowsNote>
              The list could not be read again. It shows the last answer.
            </RowsNote>
          )}
          <LeaseRows rows={rows} on={on} now={now} />
        </>
      )}
    </Setting>
  );
}

function LeaseRows({
  rows,
  on,
  now,
}: {
  rows: LeaseRow[];
  on: boolean;
  now: number;
}) {
  return (
    <>
      {rows.length === 0 ? (
        <RowsNote>
          {on ? "No sandboxes yet." : "No sandboxes. The built-in shell runs."}
        </RowsNote>
      ) : (
        rows.map((row) => {
          const stuck = stuckLine(row);
          return (
            <RowsLine key={row.sandbox}>
              <RowsTitle
                name={row.sandbox}
                mono
                sub={leaseSub(row)}
                lines={
                  stuck === null ? undefined : [{ text: stuck, bad: true }]
                }
                wrap={stuck !== null}
              />
              <RowsMeta bad={stuck !== null} under={leaseAge(row, now)}>
                {leaseWord(row.state)}
              </RowsMeta>
            </RowsLine>
          );
        })
      )}
    </>
  );
}
