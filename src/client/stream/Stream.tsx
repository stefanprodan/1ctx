// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The stream's card: the search in its head, then the rows, or the
// one line that says why there are none. Home and the project page
// both draw it over the entity's list; the clock that moves the times
// is the page's.

import type { StreamRow } from "../../shared/api/sessions.ts";
import { Icon } from "../lib/icons.tsx";
import { Row } from "./Row.tsx";
import { Search } from "./Search.tsx";
import "./stream.css";

export function Stream({
  rows,
  // the name of each row's project, or null on a page that is the
  // project already
  projectName,
  search,
  runs,
  empty,
  now,
}: {
  rows: StreamRow[] | null;
  projectName: (projectId: string) => string | null;
  // the query as the address has it, and where a new one goes; a list
  // without a head, the runs of an automation, has none
  search?: { value: string; onChange: (q: string) => void };
  // the Runs filter beside the search, on a page that offers it
  runs?: { on: boolean; onToggle: () => void };
  // what the card says with no rows
  empty: string;
  now: number;
}) {
  return (
    <section class="stream">
      {(search || runs) && (
        <div class="stream-head">
          {search && <Search value={search.value} onChange={search.onChange} />}
          {runs && (
            <button
              type="button"
              class={`stream-filter${runs.on ? " stream-filter-on" : ""}`}
              aria-pressed={runs.on}
              onClick={runs.onToggle}
            >
              <Icon name="clock" size={12} />
              Runs
            </button>
          )}
        </div>
      )}
      {rows === null ? (
        <p class="stream-state">Loading</p>
      ) : rows.length === 0 ? (
        <p class="stream-state">{empty}</p>
      ) : (
        rows.map((row) => (
          <Row
            key={row.session.id}
            row={row}
            projectName={projectName(row.session.projectId)}
            now={now}
          />
        ))
      )}
    </section>
  );
}
