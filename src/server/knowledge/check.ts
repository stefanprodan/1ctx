// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The storage checks shared by page writes and command commits. Names
// must form a mountable tree, and lowered caps must still let an
// oversized base shrink without allowing growth in another dimension.

import { prefixConflict } from "../../shared/knowledge.ts";
import { BadRequest, Conflict } from "../lib/errors.ts";
import type { KnowledgeCaps } from "../limits/index.ts";

export function checkNames(names: readonly string[]): void {
  const live = new Set(names);
  for (const name of names) {
    const parts = name.split("/");
    const parents = parts
      .slice(0, -1)
      .map((_, i) => parts.slice(0, i + 1).join("/"));
    const other = prefixConflict(
      name,
      parents.filter((path) => live.has(path)),
    );
    if (other !== null) {
      throw new Conflict(`${name} conflicts with file ${other}`);
    }
  }
}

export function checkFile(
  name: string,
  bytes: number,
  previous: number,
  caps: KnowledgeCaps,
): void {
  if (bytes > caps.knowledgeFileBytes && bytes >= previous) {
    throw new BadRequest(
      `${name} is ${bytes} bytes, the limit is ${caps.knowledgeFileBytes}`,
    );
  }
}

export function checkTotals(
  before: { files: number; bytes: number },
  after: { files: number; bytes: number },
  caps: KnowledgeCaps,
): void {
  checkUsage(
    before,
    after,
    caps.knowledgeFiles,
    caps.knowledgeProjectBytes,
    "base",
  );
}

export function checkScratchTotals(
  before: { files: number; bytes: number },
  after: { files: number; bytes: number },
  caps: KnowledgeCaps,
): void {
  checkUsage(before, after, caps.scratchFiles, caps.scratchBytes, "scratch");
}

export function checkUploadTotals(
  before: { files: number; bytes: number },
  after: { files: number; bytes: number },
  caps: { uploadFiles: number; uploadBytes: number },
): void {
  checkUsage(before, after, caps.uploadFiles, caps.uploadBytes, "uploads");
}

function checkUsage(
  before: { files: number; bytes: number },
  after: { files: number; bytes: number },
  files: number,
  bytes: number,
  tree: string,
): void {
  // A lowered cap must still let a base shrink, without admitting growth
  // in another dimension already over its cap.
  if (
    after.files > files &&
    (after.files > before.files ||
      (after.files === before.files && after.bytes >= before.bytes))
  ) {
    throw new BadRequest(
      `the ${tree} would have ${after.files} files, the limit is ${files}`,
    );
  }
  if (
    after.bytes > bytes &&
    (after.bytes > before.bytes ||
      (after.bytes === before.bytes && after.files >= before.files))
  ) {
    throw new BadRequest(
      `the ${tree} would be ${after.bytes} bytes, the limit is ${bytes}`,
    );
  }
}
