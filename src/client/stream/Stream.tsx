// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The stream's card: the rows, or the one line that says why there
// are none. Home and the project page both draw it over the entity's
// list; the clock that moves the times is the page's.

import type { StreamRow } from "../../shared/api/sessions.ts";
import { Row } from "./Row.tsx";
import "./stream.css";

export function Stream({
  rows,
  // the name of each row's project, or null on a page that is the
  // project already
  projectName,
  empty,
  now,
}: {
  rows: StreamRow[] | null;
  projectName: (projectId: string) => string | null;
  // what the card says with no rows and no query
  empty: string;
  now: number;
}) {
  return (
    <section class="stream">
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
