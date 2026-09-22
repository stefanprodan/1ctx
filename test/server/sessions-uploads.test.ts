// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  chatMarkdown,
  type ExportRow,
  memorySnapshot,
  type SessionRow,
} from "../../src/server/sessions/index.ts";
import type { MessageUpload } from "../../src/shared/uploads.ts";

const now = Date.UTC(2026, 8, 19, 10);
const uploads: MessageUpload[] = [
  {
    name: "docs_[one]*`\\<>#|~&\n.zip",
    archive: true,
    files: 43,
    bytes: 1234,
    saved: ["docs/internal.md"],
  },
  {
    name: "notes.md",
    archive: false,
    files: 1,
    bytes: 12,
    saved: ["notes.md"],
  },
];
const attached =
  "Attached: docs\\_\\[one\\]\\*\\`\\\\\\<\\>\\#\\|\\~\\& .zip (43 files), notes.md";
const row = (fields: Partial<ExportRow>): ExportRow => ({
  sendId: "send",
  round: 1,
  memoryRound: null,
  kind: "reply",
  slot: "answer",
  status: "done",
  error: null,
  finishReason: null,
  author: "coder",
  content: "Answer.",
  uploads: null,
  toolCalls: null,
  toolCallId: null,
  toolName: null,
  createdAt: now,
  finishedAt: now,
  ...fields,
});
const session: SessionRow = {
  id: "chat",
  projectId: "project",
  ownerId: "user",
  agentId: "agent",
  origin: "chat",
  forkedFromId: null,
  automationId: null,
  runSource: null,
  title: "*Chat*",
  status: "done",
  disabledCapabilities: [],
  revision: 1,
  createdAt: now,
  lastActivityAt: now,
  usage: null,
};

const outputs = [
  {
    name: "Markdown download",
    render: (rows: ExportRow[]) => chatMarkdown(session.title, rows, "UTC"),
  },
  {
    name: "memory chat snapshot",
    render: (rows: ExportRow[]) =>
      memorySnapshot(
        session.projectId,
        session.id,
        { byId: () => session, exportRows: () => rows },
        () => false,
      )!.markdown,
  },
];

for (const output of outputs) {
  describe(`${output.name} attachment export`, () => {
    test("puts one escaped record line below the user text", () => {
      const rows = [
        row({
          kind: "user",
          slot: null,
          author: "casey",
          content: "\n**Read** these files.  \n",
          uploads,
        }),
        row({}),
      ];
      const before = structuredClone(rows);
      expect(output.render(rows)).toBe(
        `# \\*Chat\\*\n\n## @casey 2026-09-19 10:00\n\n**Read** these files.  \n\n${attached}\n\n## @coder 2026-09-19 10:00\n\nAnswer.\n`,
      );
      expect(rows).toEqual(before);
    });

    test("keeps records with their user turns and omits non-user records", () => {
      const rows = [
        row({
          kind: "user",
          slot: null,
          author: "casey",
          content: "First question.",
          uploads,
        }),
        row({ slot: "work", content: "Hidden work.", uploads }),
        row({ kind: "tool", slot: null, content: "Hidden result.", uploads }),
        row({ uploads, status: "stopped" }),
        row({
          sendId: "summary",
          kind: "summary",
          slot: null,
          content: "Hidden summary.",
          uploads,
        }),
        row({
          sendId: "next",
          kind: "user",
          slot: null,
          author: "casey",
          content: "Next question.",
          uploads: [{ ...uploads[0]!, name: "one.zip", files: 1 }],
        }),
        row({
          sendId: "next",
          status: "streaming",
          content: "Hidden streaming answer.",
          uploads,
        }),
      ];
      expect(output.render(rows)).toBe(
        `# \\*Chat\\*\n\n## @casey 2026-09-19 10:00\n\nFirst question.\n\n${attached}\n\n## @coder 2026-09-19 10:00\n\nAnswer.\n\n_stopped_\n\n## @casey 2026-09-19 10:00\n\nNext question.\n\nAttached: one.zip (1 file)\n`,
      );
    });

    test("leaves a user message without attachments unchanged", () => {
      expect(
        output.render([
          row({
            kind: "user",
            slot: null,
            author: "casey",
            content: "Plain question.",
          }),
          row({}),
        ]),
      ).toBe(
        "# \\*Chat\\*\n\n## @casey 2026-09-19 10:00\n\nPlain question.\n\n## @coder 2026-09-19 10:00\n\nAnswer.\n",
      );
    });
  });
}
