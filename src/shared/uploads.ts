// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The files a person adds to a chat, as the wire and the prompt carry
// them: the record a user message keeps, the block the model reads, the
// line a download shows, and the folder an archive lands in under
// /uploads. Pure: the same record always gives the same bytes, so the
// cached prefix of a session holds.

import { normalizeKnowledgePath } from "./knowledge.ts";

export const UPLOADS_ROOT = "/uploads";

// the 409 of a second upload while the person's first still runs; the
// composer waits and tries again instead of refusing the file
export const UPLOAD_RUNNING = "an upload is running";

// one send names at most this many staged items
export const MAX_UPLOADS_PER_MESSAGE = 10;
// a picked item's name as it is shown, stored and answered
export const MAX_UPLOAD_NAME = 200;
// the names a record keeps per item, and the block names over all items
export const MAX_RECORD_NAMES = 20;
export const MAX_BLOCK_NAMES = 20;
// the whole record as JSON
export const MAX_UPLOAD_RECORD_BYTES = 32 * 1024;

// what one picked item left under /uploads, as it was at the send: a
// later message may replace a file, the record stays
export type MessageUpload = {
  // the picked item's name, cut to MAX_UPLOAD_NAME
  name: string;
  // an archive lands under its folder, a loose file at the root
  archive: boolean;
  files: number;
  bytes: number;
  // the first names as saved, paths under /uploads without the root
  saved: string[];
};

const ARCHIVE_END = /\.(zip|tgz|tar\.gz|tar)$/i;

// the folder an archive expands under: its name without the archive
// ending, normalized as any uploaded path, `archive` when nothing is left
export function uploadFolder(name: string): string {
  const base = name.replace(ARCHIVE_END, "").replace(/[\\/]/g, "-");
  const result = normalizeKnowledgePath(base);
  return result.ok ? result.name : "archive";
}

const bytesOf = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

// the record within its ceiling: every item keeps its name, its count
// and its bytes, and the later items' names give way first
export function boundRecord(items: MessageUpload[]): MessageUpload[] {
  const record = items.slice(0, MAX_UPLOADS_PER_MESSAGE).map((item) => ({
    ...item,
    name: item.name.slice(0, MAX_UPLOAD_NAME),
    saved: item.saved.slice(0, MAX_RECORD_NAMES),
  }));
  for (let i = record.length - 1; i >= 0; i--) {
    while (
      record[i]!.saved.length > 0 &&
      bytesOf(record) > MAX_UPLOAD_RECORD_BYTES
    ) {
      record[i]!.saved.pop();
    }
  }
  return record;
}

const plural = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

// what the model reads under a user message that carried files
export function uploadsBlock(record: MessageUpload[]): string {
  const total = record.reduce((n, item) => n + item.files, 0);
  const names = record.flatMap((item) => item.saved).slice(0, MAX_BLOCK_NAMES);
  const more = total - names.length;
  const list =
    names.length === 0
      ? ""
      : `: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  return `<uploads>\nThe user attached ${plural(total)}, now under ${UPLOADS_ROOT}${list}. Read them with the bash tool.\n</uploads>`;
}

// after a summary the earlier blocks are gone with their rows
export const UPLOADS_SUMMARY_LINE = `Files the user attached earlier are under ${UPLOADS_ROOT}.`;

// one line under a user message in a download or a snapshot, raw: the
// caller escapes it as it escapes a title
export function attachedLine(record: MessageUpload[]): string {
  const items = record.map((item) =>
    item.archive ? `${item.name} (${plural(item.files)})` : item.name,
  );
  return `Attached: ${items.join(", ")}`;
}
