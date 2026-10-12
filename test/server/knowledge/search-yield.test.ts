// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Knowledge search as it yields: writes land between its steps, and
// each row it shows is one revision's metadata and lines.

import { describe, expect, test } from "bun:test";
import {
  prepareSearch,
  type SearchSource,
  search,
} from "../../../src/server/knowledge/search.ts";
import { searchQueue } from "../../../src/server/lib/search-queue.ts";
import { type Setup, setup } from "./helpers.ts";

const source = (s: Setup): SearchSource => ({
  ids: () => s.area.store.fileIds(s.projectId),
  row: (fileId) => s.area.store.withText(s.projectId, fileId),
});

// a yield at every step, so a write queued before lands mid-scan
const everyStep = () => searchQueue({ sliceMs: 0 });

function project(files: Record<string, string>): Setup {
  const s = setup();
  for (const [name, text] of Object.entries(files)) {
    s.area.create(s.projectId, s.author, name, text);
  }
  return s;
}

describe("knowledge search while it yields", () => {
  test("a file deleted mid-scan is neither a text nor a name row", async () => {
    const s = project({
      "a.md": "a topic\n",
      "b.md": "a topic too\n",
      "topic-name.md": "none\n",
    });
    try {
      const ids = ["b.md", "topic-name.md"].map(
        (name) => s.area.store.fileNamed(s.projectId, name)!.id,
      );
      // after the snapshot, before the first read
      setImmediate(() => {
        for (const id of ids) s.area.remove(s.projectId, s.author, id);
      });
      const page = await everyStep().run({ from: "page" }, (step) =>
        search(source(s), prepareSearch("topic", null), step),
      );
      expect(page.files.map((hit) => hit.file.name)).toEqual(["a.md"]);
      expect(page).toMatchObject({ names: [], namesTotal: 0, next: null });
    } finally {
      s.db.close();
    }
  });

  test("a file written mid-scan shows one revision's metadata and lines", async () => {
    const s = project({ "a.md": "first topic line\n" });
    try {
      const id = s.area.store.fileNamed(s.projectId, "a.md")!.id;
      const text = "other\nsecond topic here\n";
      let reads = 0;
      const page = await everyStep().run({ from: "page" }, (step) =>
        search(
          {
            ids: source(s).ids,
            row: (fileId) => {
              // written between the scan's read and the page's
              if (reads++ === 0) {
                setImmediate(() =>
                  s.area.replace(s.projectId, s.author, id, text, 1),
                );
              }
              return source(s).row(fileId);
            },
          },
          prepareSearch("topic", null),
          step,
        ),
      );
      expect(reads).toBe(2);
      expect(page.files).toHaveLength(1);
      const [hit] = page.files;
      expect(hit!.file).toMatchObject({
        revision: 2,
        bytes: Buffer.byteLength(text),
        lines: 2,
      });
      expect(hit!.lines).toEqual([
        { line: 2, text: "second topic here", cutStart: false, cutEnd: false },
      ]);
    } finally {
      s.db.close();
    }
  });

  test("a scan stops at its next yield once its caller left", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.md`] = "a topic\n";
    const s = project(files);
    try {
      const caller = new AbortController();
      let reads = 0;
      const searching = everyStep().run(
        { from: "page", signal: caller.signal },
        (step) =>
          search(
            {
              ids: source(s).ids,
              row: (fileId) => {
                if (++reads === 3) caller.abort();
                return source(s).row(fileId);
              },
            },
            prepareSearch("topic", null),
            step,
          ),
      );
      await expect(searching).rejects.toMatchObject({ status: 499 });
      expect(reads).toBe(3);
    } finally {
      s.db.close();
    }
  });
});
