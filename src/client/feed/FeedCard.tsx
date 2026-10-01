// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The feed's card, a Rows card: the search and the filters in its
// head, then the session rows, or the note that says why there are
// none, and Show more while a later page is left. The session row is
// the one row outside Rows: a denser feed line. Home and the project
// page both draw it over the entity's list; the clock that moves the
// times is the page's.

import type { FeedRow } from "../../shared/api/sessions.ts";
import type { SessionOrigin } from "../../shared/words.ts";
import type { Failure } from "../lib/format.ts";
import type { IconName } from "../lib/icons.tsx";
import {
  RowsButton,
  RowsCard,
  RowsFailed,
  RowsFilters,
  RowsNote,
} from "../ui/Rows.tsx";
import { Search } from "../ui/Search.tsx";
import { Row } from "./Row.tsx";
import "./feed.css";

const FILTERS: {
  value: SessionOrigin | null;
  label: string;
  icon: IconName | null;
}[] = [
  { value: null, label: "All", icon: null },
  { value: "chat", label: "Chats", icon: "chat" },
  { value: "automation", label: "Tasks", icon: "bolt" },
];

// whether a later page is left, and how its load went
export type MoreState = {
  next: boolean;
  loading: boolean;
  error: Failure | null;
};

export function FeedCard({
  rows,
  // the name of each row's project, or null on a page that is the
  // project already
  projectName,
  search,
  filter,
  empty,
  now,
  more,
  onMore,
}: {
  rows: FeedRow[] | null;
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
  more: MoreState;
  onMore: () => void;
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
        <Ghosts count={6} />
      ) : rows.length === 0 ? (
        <RowsNote>{empty}</RowsNote>
      ) : (
        <>
          {rows.map((row) => (
            <Row
              key={row.session.id}
              row={row}
              projectName={projectName(row.session.projectId)}
              now={now}
            />
          ))}
          <ShowMore more={more} onMore={onMore} />
        </>
      )}
    </RowsCard>
  );
}

// the list's last row while a later page is left: the button, the
// placeholders while the page loads, and a failure under the button
export function ShowMore({
  more,
  onMore,
}: {
  more: MoreState;
  onMore: () => void;
}) {
  if (!more.next) return null;
  if (more.loading) return <Ghosts count={3} />;
  return (
    <>
      <RowsButton onClick={onMore}>Show more</RowsButton>
      {more.error !== null && <RowsFailed failure={more.error} />}
    </>
  );
}

// placeholder rows in the shape of the real ones while rows load, so
// the rows land where the shapes were
function Ghosts({ count }: { count: number }) {
  return (
    <div class="feed-ghosts" role="status" aria-label="Loading sessions">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          class={`feed-row feed-ghost feed-ghost-${"abc"[i % 3]}`}
          style={{ "--ghost": i }}
          aria-hidden="true"
        >
          <span class="feed-bone feed-bone-icon" />
          <span class="feed-text">
            <span class="feed-title">
              <span class="feed-bone feed-bone-title" />
            </span>
            <span class="feed-line">
              <span class="feed-bone feed-bone-line" />
            </span>
          </span>
          <span class="feed-when">
            <span class="feed-bone feed-bone-when" />
          </span>
        </div>
      ))}
    </div>
  );
}
