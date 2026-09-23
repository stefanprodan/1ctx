// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The place of a row in a listed order, so a later page starts after
// it. The feed's order is running first, then last activity newest
// first, then id; the runs' drops the rank, since an automation never
// runs twice at once. A cursor is a place, not a row: one naming a
// deleted row still pages. Paging is not a snapshot: a row that moves
// above the cursor is not on a later page.

import { BadRequest } from "../lib/errors.ts";
import type { RawSession } from "./rows.ts";

export type FeedCursor = { running: 0 | 1; at: number; id: string };
export type RunsCursor = { at: number; id: string };

export type After = { sql: string; args: (string | number)[] };

const ID = /^[0-9a-z]{12}$/;
const TIME = /^(0|[1-9][0-9]*)$/;
const NONE: After = { sql: "", args: [] };

export const feedCursor = (raw: RawSession): string =>
  `${raw.status === "running" ? 1 : 0}.${raw.last_activity_at}.${raw.id}`;

export const runsCursor = (raw: RawSession): string =>
  `${raw.last_activity_at}.${raw.id}`;

function place(time: string | undefined, id: string | undefined) {
  if (time === undefined || !TIME.test(time)) {
    throw new BadRequest("invalid cursor");
  }
  const at = Number(time);
  if (!Number.isSafeInteger(at) || id === undefined || !ID.test(id)) {
    throw new BadRequest("invalid cursor");
  }
  return { at, id };
}

export function parseFeedCursor(value: string): FeedCursor {
  const parts = value.split(".");
  if (parts.length !== 3 || (parts[0] !== "0" && parts[0] !== "1")) {
    throw new BadRequest("invalid cursor");
  }
  return { running: parts[0] === "1" ? 1 : 0, ...place(parts[1], parts[2]) };
}

export function parseRunsCursor(value: string): RunsCursor {
  const parts = value.split(".");
  if (parts.length !== 2) throw new BadRequest("invalid cursor");
  return place(parts[0], parts[1]);
}

export function feedAfter(cursor: FeedCursor | null): After {
  if (cursor === null) return NONE;
  return {
    sql: `and ((status = 'running') < ? or ((status = 'running') = ?
            and (last_activity_at < ?
              or (last_activity_at = ? and id > ?))))`,
    args: [cursor.running, cursor.running, cursor.at, cursor.at, cursor.id],
  };
}

export function runsAfter(cursor: RunsCursor | null): After {
  if (cursor === null) return NONE;
  return {
    sql: "and (last_activity_at < ? or (last_activity_at = ? and id > ?))",
    args: [cursor.at, cursor.at, cursor.id],
  };
}
