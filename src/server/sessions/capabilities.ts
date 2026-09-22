// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "../db/index.ts";

export function setDisabled(db: Db, id: string, set: readonly string[]): void {
  db.query("update sessions set disabled_capabilities = ? where id = ?").run(
    JSON.stringify(set),
    id,
  );
}

export function forgetCapability(db: Db, key: string): void {
  db.query(
    `update sessions set disabled_capabilities = (
       select json_group_array(value order by value)
       from json_each(sessions.disabled_capabilities) where value != ?
     ) where exists (
       select 1 from json_each(sessions.disabled_capabilities) where value = ?
     )`,
  ).run(key, key);
}
