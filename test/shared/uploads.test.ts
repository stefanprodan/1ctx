// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  attachedLine,
  boundRecord,
  MAX_RECORD_NAMES,
  MAX_UPLOAD_NAME,
  MAX_UPLOAD_RECORD_BYTES,
  MAX_UPLOADS_PER_MESSAGE,
  type MessageUpload,
  UPLOADS_SUMMARY_LINE,
  uploadFolder,
  uploadsBlock,
} from "../../src/shared/uploads.ts";

const item = (fields: Partial<MessageUpload> = {}): MessageUpload => ({
  name: "notes.md",
  archive: false,
  files: 1,
  bytes: 12,
  saved: ["notes.md"],
  ...fields,
});

describe("the folder an archive lands in", () => {
  test.each([
    ["docs.zip", "docs"],
    ["My Docs.tar.gz", "my-docs"],
    ["Run Books.TGZ", "run-books"],
    ["backup.tar", "backup"],
    ["a/b\\c.zip", "a-b-c"],
    ["----.zip", "archive"],
    [".zip", "archive"],
    [`${"x".repeat(90)}.zip`, "archive"],
  ])("%s lands under %s", (name, folder) => {
    expect(uploadFolder(name)).toBe(folder);
  });
});

describe("the block the model reads", () => {
  test("names every file of a small record", () => {
    expect(
      uploadsBlock([
        item(),
        item({
          name: "docs.zip",
          archive: true,
          files: 2,
          saved: ["docs/a.md", "docs/b.md"],
        }),
      ]),
    ).toBe(
      "<uploads>\nThe user attached 3 files, now under /uploads: notes.md, docs/a.md, docs/b.md. Read them with the bash tool.\n</uploads>",
    );
  });

  test("names twenty over all items, then counts the rest", () => {
    const saved = Array.from({ length: 20 }, (_, i) => `docs/${i}.md`);
    const block = uploadsBlock([
      item({ name: "docs.zip", archive: true, files: 43, saved }),
      item(),
    ]);
    expect(block).toContain("The user attached 44 files");
    expect(block).toContain("docs/19.md and 24 more.");
    expect(block).not.toContain("notes.md");
  });

  test("says one file in the singular", () => {
    expect(uploadsBlock([item()])).toContain("attached 1 file, now");
  });

  test("counts alone when the record kept no names", () => {
    expect(uploadsBlock([item({ files: 7, saved: [] })])).toBe(
      "<uploads>\nThe user attached 7 files, now under /uploads. Read them with the bash tool.\n</uploads>",
    );
  });

  test("is the same bytes for the same record", () => {
    const record = [item(), item({ name: "b.log", saved: ["b.log"] })];
    expect(uploadsBlock(record)).toBe(
      uploadsBlock(JSON.parse(JSON.stringify(record))),
    );
  });

  test("the line after a summary names the root", () => {
    expect(UPLOADS_SUMMARY_LINE).toBe(
      "Files the user attached earlier are under /uploads.",
    );
  });
});

describe("the record a message keeps", () => {
  test("cuts the name, the names and the items", () => {
    const record = boundRecord(
      Array.from({ length: 12 }, () =>
        item({
          name: "n".repeat(300),
          saved: Array.from({ length: 30 }, (_, i) => `f${i}.md`),
        }),
      ),
    );
    expect(record).toHaveLength(MAX_UPLOADS_PER_MESSAGE);
    expect(record[0]?.name).toHaveLength(MAX_UPLOAD_NAME);
    expect(record[0]?.saved).toHaveLength(MAX_RECORD_NAMES);
  });

  test("holds the worst case under its ceiling, the later names first to go", () => {
    // ten items of twenty 200-character names that escape to six bytes each
    const name = "\u0001".repeat(200);
    const record = boundRecord(
      Array.from({ length: 10 }, (_, i) =>
        item({
          name,
          archive: true,
          files: 2000,
          bytes: 1_000_000 + i,
          saved: Array.from({ length: 20 }, () => name),
        }),
      ),
    );
    const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_UPLOAD_RECORD_BYTES);
    expect(record).toHaveLength(10);
    expect(record.every((r) => r.files === 2000 && r.bytes >= 1_000_000)).toBe(
      true,
    );
    expect(record[0]?.saved.length).toBeGreaterThan(0);
    expect(record[9]?.saved).toHaveLength(0);
  });

  test("does not change its input", () => {
    const items = [item({ saved: ["a.md", "b.md"] })];
    boundRecord(items);
    expect(items[0]?.saved).toEqual(["a.md", "b.md"]);
  });
});

describe("the line a download shows", () => {
  test("an archive with its count, a file by its name", () => {
    expect(
      attachedLine([
        item({ name: "docs.zip", archive: true, files: 43 }),
        item(),
        item({ name: "one.tgz", archive: true, files: 1 }),
      ]),
    ).toBe("Attached: docs.zip (43 files), notes.md, one.tgz (1 file)");
  });
});
