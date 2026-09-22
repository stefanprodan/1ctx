// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "../db/index.ts";
import type { OpenedRecord } from "../knowledge/index.ts";

export function readOpenedFile(
  db: Db,
  messageId: string,
  index: number,
): OpenedRecord | null {
  return db
    .query<OpenedRecord, [string, number]>(
      `select path, kind, language, bytes, lines, title, text
       from opened_files where message_id = ? and position = ?`,
    )
    .get(messageId, index);
}

export function writeOpenedFiles(
  db: Db,
  messageId: string,
  files: readonly OpenedRecord[],
): void {
  const insert = db.query(
    `insert into opened_files
       (message_id, position, path, kind, language, bytes, lines, title, text)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  files.forEach((file, position) => {
    insert.run(
      messageId,
      position,
      file.path,
      file.kind,
      file.language,
      file.bytes,
      file.lines,
      file.title,
      file.text,
    );
  });
}
