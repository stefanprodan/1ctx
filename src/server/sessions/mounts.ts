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

// the first write wins, so a second summon of one message keeps the
// first one's; a regenerate replaces it with what it mounted
export function setReposBlock(
  db: Db,
  messageId: string,
  block: string,
  replace = false,
) {
  db.query(
    `update messages set repos_block = ? where id = ?${replace ? "" : " and repos_block is null"}`,
  ).run(block === "" ? null : block, messageId);
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
    setReposBlock(this.db, messageId, block, replace);
  }

  mountedBefore(sessionId: string, firstMessageId: string): MountedRepos[] {
    return mountedBefore(this.db, sessionId, firstMessageId);
  }
}
