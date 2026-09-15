// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The stream's card: the search in its head, then the rows, or the
// one line that says why there are none. Home and the project page
// both draw it over the entity's list; the clock that moves the times
// is the page's.

import type { StreamRow } from "../../shared/api/sessions.ts";
import type { SessionOrigin } from "../../shared/words.ts";
import { Icon, type IconName } from "../lib/icons.tsx";
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
  // the query as the address has it, and where a new one goes; a list
  // without a head, the runs of an automation, has none
  search?: { value: string; onChange: (q: string) => void };
  // All, Chats or Tasks beside the search, on a page that offers it
  filter?: {
    value: SessionOrigin | null;
    onPick: (origin: SessionOrigin | null) => void;
  };
  // what the card says with no rows
  empty: string;
  now: number;
}) {
  return (
    <section class="stream">
      {(search || filter) && (
        <div class="stream-head">
          {search && (
            <Search
              value={search.value}
              onChange={search.onChange}
              placeholder="Search sessions"
            />
          )}
          {filter && (
            <div class="stream-filters">
              {FILTERS.map((choice) => (
                <button
                  key={choice.label}
                  type="button"
                  class={`stream-filter${filter.value === choice.value ? " stream-filter-on" : ""}`}
                  aria-pressed={filter.value === choice.value}
                  onClick={() => filter.onPick(choice.value)}
                >
                  {choice.icon && <Icon name={choice.icon} size={12} />}
                  {choice.label}
                </button>
              ))}
            </div>
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
