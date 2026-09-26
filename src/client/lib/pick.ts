// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A picked file judged by the server's own rules before a byte is
// sent: what it is from its first bytes, whether the upload takes its
// size, and whether a loose file is text. The Knowledge uploader and
// the composer both pick through it, with the limits the server
// answered, never a number of their own.

import { sniffArchive } from "../../shared/archive.ts";
import type { KnowledgeUploadReason } from "../../shared/contracts/knowledge.ts";
import { textFromBytes } from "../../shared/knowledge.ts";

export type PickKind = "zip" | "gzip" | "tar" | "text";
export type PickSkip = KnowledgeUploadReason | "upload-size";

// a skipped name's reason, as a log line says it
export function skipWords(reason: PickSkip): string {
  const words: Record<PickSkip, string> = {
    "not-regular": "not a regular file",
    outside: "outside the folder",
    "no-letters": "no letters or digits",
    "too-long": "name too long",
    "bad-name": "bad name",
    duplicate: "duplicate name",
    "too-big": "over the file limit",
    "not-text": "not text",
    clash: "clashes with another",
    "clash-live": "clashes with a file",
    "upload-size": "over the 32 MB upload limit",
  };
  return words[reason];
}

export type PickRules = {
  // the most one upload carries
  itemBytes: number;
  // the most one text file holds; a larger loose file is judged by its
  // name, since a replacement may shrink what is there
  fileBytes: number;
};

export async function judgePick(
  file: File,
  rules: PickRules,
): Promise<{ kind: PickKind; invalid: PickSkip | null }> {
  if (file.size > rules.itemBytes) {
    return { kind: "text", invalid: "upload-size" };
  }
  const kind =
    sniffArchive(new Uint8Array(await file.slice(0, 512).arrayBuffer())) ??
    "text";
  if (kind === "text" && file.size <= rules.fileBytes) {
    // a read that fails is the caller's to report, not a verdict on the file
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      textFromBytes(bytes);
    } catch {
      return { kind, invalid: "not-text" };
    }
  }
  return { kind, invalid: null };
}
