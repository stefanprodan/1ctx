// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "../db/index.ts";

// the commit each repository was mounted at in a turn, kept on the
// turn's first message: repository id to commit
export type MountedRepos = Record<string, string>;

export function setMountedRepos(
  db: Db,
  messageId: string,
  mounted: MountedRepos,
): void {
  db.query("update messages set mounted_repos = ? where id = ?").run(
    JSON.stringify(mounted),
    messageId,
  );
}

export function readMountedRepos(
  db: Db,
  messageId: string,
): MountedRepos | null {
  const row = db
    .query<{ mounted_repos: string | null }, [string]>(
      "select mounted_repos from messages where id = ?",
    )
    .get(messageId);
  return row?.mounted_repos
    ? (JSON.parse(row.mounted_repos) as MountedRepos)
    : null;
}

// what a turn's first send said before its first message, kept as the
// model read it. The first write wins, so a second summon of one
// message keeps the first one's; a regenerate replaces it with its own.
// Empty is stored as none
export function setTurnText(
  db: Db,
  column: "repos_block" | "turn_note",
  messageId: string,
  text: string,
  replace = false,
) {
  db.query(
    `update messages set ${column} = ? where id = ?${replace ? "" : ` and ${column} is null`}`,
  ).run(text === "" ? null : text, messageId);
}

// each earlier turn's mounted commits, newest first, from its first
// message: the sends of a chat are few where its messages are many.
// Every send that shares the turn's first message is the turn itself,
// as a channel's post send and a regenerated send are
export function mountedBefore(
  db: Db,
  sessionId: string,
  firstMessageId: string,
): MountedRepos[] {
  return db
    .query<{ mounted_repos: string }, [string, string]>(
      `select messages.mounted_repos from sends
       join messages on messages.id = sends.first_message_id
       where sends.session_id = ? and sends.first_message_id != ?
         and messages.mounted_repos is not null
       order by sends.started_at desc, sends.rowid desc`,
    )
    .all(sessionId, firstMessageId)
    .map((row) => JSON.parse(row.mounted_repos) as MountedRepos);
}

// what a turn's repositories leave on its first message
export class MountsStore {
  constructor(private readonly db: Db) {}

  setMountedRepos(messageId: string, mounted: MountedRepos): void {
    setMountedRepos(this.db, messageId, mounted);
  }

  mountedRepos(messageId: string): MountedRepos | null {
    return readMountedRepos(this.db, messageId);
  }

  setReposBlock(messageId: string, block: string, replace = false): void {
    setTurnText(this.db, "repos_block", messageId, block, replace);
  }

  setTurnNote(messageId: string, note: string, replace = false): void {
    setTurnText(this.db, "turn_note", messageId, note, replace);
  }

  mountedBefore(sessionId: string, firstMessageId: string): MountedRepos[] {
    return mountedBefore(this.db, sessionId, firstMessageId);
  }
}
