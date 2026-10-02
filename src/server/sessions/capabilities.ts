// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "../db/index.ts";

export function setDisabled(db: Db, id: string, set: readonly string[]): void {
  db.query("update sessions set disabled_capabilities = ? where id = ?").run(
    JSON.stringify(set),
    id,
  );
}

// every session's set, or one project's when the key's object was the
// project's, so a repository's delete reads only its project's rows
export function forgetCapability(
  db: Db,
  key: string,
  projectId?: string,
): void {
  db.query(
    `update sessions set disabled_capabilities = (
       select json_group_array(value order by value)
       from json_each(sessions.disabled_capabilities) where value != ?
     ) where ${projectId === undefined ? "" : "project_id = ? and "}exists (
       select 1 from json_each(sessions.disabled_capabilities) where value = ?
     )`,
  ).run(key, ...(projectId === undefined ? [] : [projectId]), key);
}
