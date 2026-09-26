// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An archived chat's and an ended run's large tool results are stored
// compressed. Neither ever sends again, so no live path meets a packed
// row; only the result route and Fork read one back, by id.

import type { Db } from "../db/index.ts";

// in UTF-8 bytes; a smaller result gains too little to pay a decode
export const PACK_FROM = 1024;

const PACK_LEVEL = 3;

// the unpacked tool rows worth packing, as a condition on messages. A
// failed row keeps its text in error too, so packing it saves nothing.
// The messages_packable index in 0030 repeats it term for term
export const PACKABLE = `messages.kind = 'tool' and messages.packed is null
  and messages.status in ('done', 'stopped')
  and octet_length(messages.content) >= ${PACK_FROM}`;

// every packable tool row of the session, in the caller's transaction;
// how many were packed. The caller makes sure nothing runs in it
export function packRows(db: Db, sessionId: string): number {
  const rows = db
    .query<{ id: string; content: string }, [string]>(
      `select id, content from messages
       where session_id = ? and ${PACKABLE}`,
    )
    .all(sessionId);
  const write = db.query(
    `update messages set packed = ?, packed_bytes = ?, content = ''
     where id = ? and packed is null`,
  );
  let packed = 0;
  for (const row of rows) {
    const bytes = Buffer.from(row.content, "utf8");
    const blob = Bun.zstdCompressSync(bytes, { level: PACK_LEVEL });
    packed += write.run(blob, bytes.byteLength, row.id).changes;
  }
  return packed;
}

// a tool row's text, decompressed when it is packed; null when the row
// is not there
export function resultText(db: Db, messageId: string): string | null {
  const row = db
    .query<{ content: string; packed: Uint8Array | null }, [string]>(
      "select content, packed from messages where id = ?",
    )
    .get(messageId);
  if (row === null) return null;
  return row.packed === null ? row.content : unpack(row.packed);
}

// the packed text of a row, null when it is plain
export function packedText(db: Db, messageId: string): string | null {
  const row = db
    .query<{ packed: Uint8Array | null }, [string]>(
      "select packed from messages where id = ?",
    )
    .get(messageId);
  return row?.packed == null ? null : unpack(row.packed);
}

const unpack = (blob: Uint8Array): string =>
  Buffer.from(Bun.zstdDecompressSync(blob)).toString("utf8");
