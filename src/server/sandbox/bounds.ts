// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How far a walk after a command may go: pure, from the caps and what
// the trees held before it.

import type { KnowledgeCaps } from "../limits/index.ts";
import { heldSizes, type Tree } from "./baseline.ts";
import { PATH_BYTES } from "./readout.ts";
import { TREE_SLACK_BYTES } from "./spec.ts";

// The walk's bounds: what the caps allow, or what the trees held when
// that was more, so a tree over a lowered cap can still shrink.
export function walkBounds(caps: KnowledgeCaps, before: Tree | null) {
  const held = heldSizes(before);
  const tree = (root: string, cap: number) =>
    Math.max(cap, held.bytes.get(root) ?? 0) + TREE_SLACK_BYTES;
  const entries = Math.max(
    4 * (caps.knowledgeFiles + caps.uploadFiles + caps.mcpKeptFiles) + 64,
    held.entries + 64,
  );
  const fileBytes = Math.max(
    caps.knowledgeFileBytes,
    caps.uploadBytes,
    caps.mcpKeptBytes,
    held.largest,
  );
  const totalBytes =
    tree("/knowledge", caps.knowledgeProjectBytes) +
    tree("/uploads", caps.uploadBytes) +
    tree("/mcp", caps.mcpKeptBytes);
  return {
    limits: { entries, fileBytes, totalBytes },
    bounds: {
      entries: entries + 4,
      nameBytes: entries * PATH_BYTES,
      fileBytes: totalBytes,
    },
  };
}
