// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

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
  // A lowered cap must still let a base shrink, without admitting growth
  // in another dimension already over its cap.
  if (
    after.files > caps.knowledgeFiles &&
    (after.files > before.files ||
      (after.files === before.files && after.bytes >= before.bytes))
  ) {
    throw new BadRequest(
      `the base would have ${after.files} files, the limit is ${caps.knowledgeFiles}`,
    );
  }
  if (
    after.bytes > caps.knowledgeProjectBytes &&
    (after.bytes > before.bytes ||
      (after.bytes === before.bytes && after.files >= before.files))
  ) {
    throw new BadRequest(
      `the base would be ${after.bytes} bytes, the limit is ${caps.knowledgeProjectBytes}`,
    );
  }
}
