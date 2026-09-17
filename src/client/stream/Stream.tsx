// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The stream's card, a Rows card: the search and the filters in its
// head, then the session rows, or the note that says why there are
// none. The session row is the one row outside Rows: a denser feed
// line, as the Home plan draws it. Home and the project page both draw
// it over the entity's list; the clock that moves the times is the
// page's.

import type { StreamRow } from "../../shared/api/sessions.ts";
import type { SessionOrigin } from "../../shared/words.ts";
import type { IconName } from "../lib/icons.tsx";
import { RowsCard, RowsFilters, RowsNote } from "../ui/Rows.tsx";
import { Search } from "../ui/Search.tsx";
import { Row } from "./Row.tsx";
import "./stream.css";

const FILTERS: {
  value: SessionOrigin | null;
  label: string;
  icon: IconName | null;
}[] = [
  { value: null, label: "All", icon: null },
  { value: "chat", label: "Chats", icon: "chat" },
  { value: "automation", label: "Tasks", icon: "bolt" },
];

export function Stream({
  rows,
  // the name of each row's project, or null on a page that is the
  // project already
  projectName,
  search,
  filter,
  empty,
  now,
}: {
  rows: StreamRow[] | null;
  projectName: (projectId: string) => string | null;
  // the query as the address has it, and where a new one goes
  search: { value: string; onChange: (q: string) => void };
  // All, Chats or Tasks beside the search
  filter: {
    value: SessionOrigin | null;
    onPick: (origin: SessionOrigin | null) => void;
  };
  // what the card says with no rows
  empty: string;
  now: number;
}) {
  return (
    <RowsCard
      label="Sessions"
      search={
        <Search
          value={search.value}
          onChange={search.onChange}
          placeholder="Search sessions"
        />
      }
      action={
        <RowsFilters
          label="Show"
          filters={FILTERS.map((choice) => ({
            label: choice.label,
            icon: choice.icon ?? undefined,
            on: filter.value === choice.value,
            onPick: () => filter.onPick(choice.value),
          }))}
        />
      }
    >
      {rows === null ? (
        <RowsNote>Loading</RowsNote>
      ) : rows.length === 0 ? (
        <RowsNote>{empty}</RowsNote>
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
    </RowsCard>
  );
}
