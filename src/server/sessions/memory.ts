// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One immutable chat snapshot for the memory tool. The store supplies both
// reads so the markdown and activity cursor describe the same transaction.

import { chatMarkdown, type ExportRow } from "./markdown.ts";
import type { SessionRow } from "./rows.ts";

export type MemorySnapshot = {
  id: string;
  title: string;
  lastActivityAt: number;
  markdown: string;
};

export function memorySnapshot(
  projectId: string,
  id: string,
  reads: {
    byId(id: string): SessionRow | null;
    exportRows(id: string): ExportRow[];
  },
  isWrite: (name: string) => boolean,
): MemorySnapshot | null {
  const session = reads.byId(id);
  if (
    session === null ||
    session.projectId !== projectId ||
    session.origin !== "chat" ||
    session.status === "running"
  ) {
    return null;
  }
  return {
    id: session.id,
    title: session.title,
    lastActivityAt: session.lastActivityAt,
    markdown: chatMarkdown(
      session.title,
      reads.exportRows(session.id),
      "UTC",
      isWrite,
    ),
  };
}
