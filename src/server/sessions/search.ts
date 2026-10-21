// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Every session of one project, delegated children and archived ones
// included, newest activity first: listed, or searched by words over
// the text a transcript shows (SHOWN): user messages and answers. Work
// text, the memory phase and tool rows, packed or not, are never read.
// Access is the caller's: the project is taken as checked.

import { SEARCH_LINES, SEARCH_PAGE } from "../../shared/api/knowledge.ts";
import {
  matchLines,
  type SearchLine,
  searchTerms,
} from "../../shared/search.ts";
import type { Db } from "../db/index.ts";
import { BadRequest } from "../lib/errors.ts";
import { noStep, type SearchStep } from "../lib/search-queue.ts";
import { parseRunsCursor, type RunsCursor } from "./cursor.ts";
import { SHOWN } from "./export.ts";
import { FEED_LIMIT } from "./rows.ts";

// the message text a search page reads at most; past it the page ends
// early with next set, one session a page whatever its size
export const SESSION_SCAN_BYTES = 8 * 1024 * 1024;

export const SESSION_LIST_PAGE = FEED_LIMIT;

export type SessionKind = "chat" | "run" | "channel";

export type SessionSearchLine = SearchLine & { messageId: string };

export type SessionSearchHit = {
  id: string;
  title: string;
  kind: SessionKind;
  // a delegated child's parent session, null for a root
  parentSessionId: string | null;
  lastActivityAt: number;
  // how many lines of its messages hold any word
  count: number;
  lines: SessionSearchLine[];
};

export type SessionSearchPage = {
  hits: SessionSearchHit[];
  // the cursor to pass as after for the next page, null on the last
  next: string | null;
};

export type SessionListRow = {
  id: string;
  title: string;
  kind: SessionKind;
  agent: string | null;
  owner: string | null;
  parentSessionId: string | null;
  lastActivityAt: number;
  archived: boolean;
};

export type SessionListPage = {
  sessions: SessionListRow[];
  next: string | null;
};

type RawPlace = { id: string; last_activity_at: number };

type RawFound = {
  title: string;
  origin: "chat" | "automation" | "channel";
  parent_session_id: string | null;
  bytes: number;
};

type RawListed = Omit<RawFound, "bytes"> &
  RawPlace & {
    archived_at: number | null;
    agent: string;
    owner: string;
  };

const cursorOf = (row: { last_activity_at: number; id: string }) =>
  `${row.last_activity_at}.${row.id}`;

const kindOf = (origin: "chat" | "automation" | "channel"): SessionKind =>
  origin === "automation" ? "run" : origin;

// the range on last_activity_at lets the index seek past the cursor
function past(after: RunsCursor | null): {
  sql: string;
  args: (string | number)[];
} {
  if (after === null) return { sql: "", args: [] };
  return {
    sql: `and last_activity_at <= ?
      and (last_activity_at < ?
        or (last_activity_at = ? and sessions.id > ?))`,
    args: [after.at, after.at, after.at, after.id],
  };
}

// the words and the cursor checked, before a search takes its turn
export function sessionQuery(
  q: string,
  after: string | null,
): { terms: string[]; after: RunsCursor | null } {
  const terms = searchTerms(q);
  if (terms.length === 0) throw new BadRequest("q must hold a word");
  return { terms, after: after === null ? null : parseRunsCursor(after) };
}

// The cursor is a place in activity order, so a session active again
// between two pages moves above it: shown already, it is not shown
// again; not reached yet, this search misses it. Only the order is
// read up front; each session's size and messages are read at its turn,
// so a session the page never reaches is never summed.
export async function searchSessions(
  db: Db,
  projectId: string,
  q: string,
  after: string | null,
  budget = SESSION_SCAN_BYTES,
  step: SearchStep = noStep,
): Promise<SessionSearchPage> {
  const query = sessionQuery(q, after);
  const terms = query.terms;
  const from = past(query.after);
  const order = db
    .query<RawPlace, (string | number)[]>(
      `select id, last_activity_at from sessions indexed by sessions_activity
       where project_id = ? ${from.sql}
       order by last_activity_at desc, id`,
    )
    .all(projectId, ...from.args);
  const found = db.query<RawFound, [string]>(
    `select title, origin, parent_session_id,
       (select coalesce(sum(octet_length(messages.content)), 0)
        from messages join sends on sends.id = messages.send_id
        where messages.session_id = sessions.id and ${SHOWN}) as bytes
     from sessions where id = ?`,
  );
  const texts = db.query<{ id: string; content: string }, [string]>(
    `select messages.id, messages.content
     from messages join sends on sends.id = messages.send_id
     where messages.session_id = ? and ${SHOWN} order by messages.seq`,
  );
  const hits: SessionSearchHit[] = [];
  let read = 0;
  let last: RawPlace | null = null;
  let next: string | null = null;
  for (const place of order) {
    await step();
    // its size, the budget and its messages in one stretch, so a write
    // between steps cannot split them
    const raw = found.get(place.id);
    if (raw === null) continue;
    if (last !== null && read + raw.bytes > budget) {
      next = cursorOf(last);
      break;
    }
    read += raw.bytes;
    last = place;
    const hit = matchSession(texts.all(place.id), terms);
    if (hit === null) continue;
    if (hits.length === SEARCH_PAGE) {
      const end = hits[SEARCH_PAGE - 1]!;
      next = `${end.lastActivityAt}.${end.id}`;
      break;
    }
    hits.push({
      id: place.id,
      title: raw.title,
      kind: kindOf(raw.origin),
      parentSessionId: raw.parent_session_id,
      lastActivityAt: place.last_activity_at,
      ...hit,
    });
  }
  return { hits, next };
}

// null unless the messages together hold every term
export function matchSession(
  messages: readonly { id: string; content: string }[],
  terms: readonly string[],
): { count: number; lines: SessionSearchLine[] } | null {
  const lowered = messages.map((message) => message.content.toLowerCase());
  if (!terms.every((term) => lowered.some((text) => text.includes(term)))) {
    return null;
  }
  let count = 0;
  const lines: SessionSearchLine[] = [];
  for (const message of messages) {
    const found = matchLines(
      message.content,
      terms,
      SEARCH_LINES - lines.length,
    );
    count += found.count;
    for (const line of found.lines)
      lines.push({ messageId: message.id, ...line });
  }
  return count === 0 ? null : { count, lines };
}

// since is epoch milliseconds: the sessions active at or after it
export function listSessionsOf(
  db: Db,
  projectId: string,
  since: number | null,
  after: string | null,
  limit = SESSION_LIST_PAGE,
): SessionListPage {
  const from = past(after === null ? null : parseRunsCursor(after));
  const rows = db
    .query<RawListed, (string | number)[]>(
      `select sessions.id, title, origin, parent_session_id,
         last_activity_at, archived_at, agents.name as agent,
         users.username as owner
       from sessions indexed by sessions_activity
       left join agents on agents.id = sessions.agent_id
       left join users on users.id = sessions.owner_id
       where project_id = ? and last_activity_at >= ? ${from.sql}
       order by last_activity_at desc, sessions.id limit ?`,
    )
    .all(projectId, since ?? 0, ...from.args, limit + 1);
  const page = rows.slice(0, limit);
  return {
    sessions: page.map((raw) => ({
      id: raw.id,
      title: raw.title,
      kind: kindOf(raw.origin),
      agent: raw.agent,
      owner: raw.owner,
      parentSessionId: raw.parent_session_id,
      lastActivityAt: raw.last_activity_at,
      archived: raw.archived_at !== null,
    })),
    next: rows.length > limit ? cursorOf(page.at(-1)!) : null,
  };
}
