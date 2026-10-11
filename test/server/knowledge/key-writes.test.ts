// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The writes an access key makes are the page's: its author is the
// key's user with the key's name, a revision guards every write, and an
// edit is a replace of the text it computes.

import { describe, expect, test } from "bun:test";
import { MAX_EDITS } from "../../../src/server/knowledge/index.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { BadRequest, Conflict } from "../../../src/server/lib/errors.ts";
import { silent } from "../../../src/server/lib/log.ts";
import type { KnowledgeAuthor } from "../../../src/shared/contracts/knowledge.ts";
import { type Setup, setup } from "./helpers.ts";

const keyed = (s: Setup): KnowledgeAuthor => ({
  ...s.author,
  origin: "key",
  keyName: "laptop-claude",
});

// the bus events of the project's knowledge, collected while body runs
function watched(s: Setup, body: (events: BusEvent[]) => void) {
  const events: BusEvent[] = [];
  const off = subscribe((event) => {
    if (
      event.type === "knowledge.changed" &&
      event.data.projectId === s.projectId
    ) {
      events.push(event);
    }
  }, silent);
  try {
    body(events);
  } finally {
    off();
  }
}

// the rows a refused write must leave as they were
const state = (s: Setup, fileId: string) => ({
  file: s.area.store.byId(s.projectId, fileId),
  versions: s.area.versions(s.projectId, fileId),
});

describe("knowledge writes with an access key", () => {
  test.serial(
    "a write names the key on the file, its versions and the event",
    () => {
      const s = setup();
      const key = keyed(s);
      try {
        watched(s, (events) => {
          const file = s.area.create(s.projectId, key, "plan.md", "one\n");
          expect(file.author).toEqual(key);
          s.now.value = 200;
          const replaced = s.area.replace(
            s.projectId,
            key,
            file.id,
            "two\n",
            file.revision,
          );
          expect(replaced).toMatchObject({ id: file.id, revision: 2 });
          expect(s.area.read(s.projectId, file.id).author).toEqual(key);
          expect(s.area.list(s.projectId).files[0]!.author).toEqual(key);
          const versions = s.area.versions(s.projectId, file.id);
          expect(versions.map((v) => v.author)).toEqual([key, key]);
          expect(s.area.version(s.projectId, versions[0]!.id).author).toEqual(
            key,
          );
          expect(events.map((e) => e.data)).toEqual([
            { projectId: s.projectId, file, deleted: false },
            { projectId: s.projectId, file: replaced, deleted: false },
          ]);
        });
      } finally {
        s.db.close();
      }
    },
  );

  test("a stale replace answers the page's 409", () => {
    const s = setup();
    try {
      const file = s.area.create(s.projectId, s.author, "a.md", "one");
      s.area.replace(s.projectId, s.author, file.id, "two", 1);
      expect(() =>
        s.area.replace(s.projectId, keyed(s), file.id, "three", 1),
      ).toThrow(new Conflict("a.md is at revision 2"));
    } finally {
      s.db.close();
    }
  });

  test("a page write after a key's write carries no key name", () => {
    const s = setup();
    try {
      const file = s.area.create(s.projectId, keyed(s), "a.md", "one");
      const replaced = s.area.replace(s.projectId, s.author, file.id, "x", 1);
      expect(replaced.author).toEqual(s.author);
      expect(
        s.area.versions(s.projectId, file.id).map((v) => v.author.keyName),
      ).toEqual([null, "laptop-claude"]);
    } finally {
      s.db.close();
    }
  });

  test("a rename keeps the id and history and names the key", () => {
    const s = setup();
    const key = keyed(s);
    try {
      const file = s.area.create(s.projectId, s.author, "a.md", "text\n");
      const renamed = s.area.rename(s.projectId, key, file.id, "b.md", 1);
      expect(renamed).toMatchObject({ id: file.id, name: "b.md", revision: 2 });
      expect(renamed.author).toEqual(key);
      expect(
        s.area
          .versions(s.projectId, file.id)
          .map((v) => [v.revision, v.name, v.author.keyName]),
      ).toEqual([
        [2, "b.md", "laptop-claude"],
        [1, "a.md", null],
      ]);
    } finally {
      s.db.close();
    }
  });

  describe("remove", () => {
    test("on a moved revision answers 409 and the file stays", () => {
      const s = setup();
      try {
        const file = s.area.create(s.projectId, s.author, "a.md", "one");
        s.area.replace(s.projectId, s.author, file.id, "two", 1);
        const before = state(s, file.id);
        expect(() => s.area.remove(s.projectId, keyed(s), file.id, 1)).toThrow(
          new Conflict("a.md is at revision 2"),
        );
        expect(state(s, file.id)).toEqual(before);
        expect(s.area.list(s.projectId).deleted).toEqual([]);
      } finally {
        s.db.close();
      }
    });

    test.serial("on the current revision deletes and names the key", () => {
      const s = setup();
      const key = keyed(s);
      try {
        const file = s.area.create(s.projectId, s.author, "a.md", "one");
        watched(s, (events) => {
          const removed = s.area.remove(s.projectId, key, file.id, 1);
          expect(removed).toMatchObject({ id: file.id, revision: 2 });
          expect(events.map((e) => e.data)).toEqual([
            { projectId: s.projectId, file: removed, deleted: true },
          ]);
        });
        expect(s.area.store.byId(s.projectId, file.id)).toBeNull();
        const [binned] = s.area.list(s.projectId).deleted;
        expect(binned!.deletedBy).toEqual(key);
        expect(binned!.author).toEqual(s.author);
        expect(
          s.area.versions(s.projectId, file.id).map((v) => v.author.keyName),
        ).toEqual(["laptop-claude", null]);
      } finally {
        s.db.close();
      }
    });

    test("without a revision deletes whatever the file's", () => {
      const s = setup();
      try {
        const file = s.area.create(s.projectId, s.author, "a.md", "one");
        s.area.replace(s.projectId, s.author, file.id, "two", 1);
        s.area.remove(s.projectId, s.author, file.id);
        expect(s.area.store.byId(s.projectId, file.id)).toBeNull();
      } finally {
        s.db.close();
      }
    });

    test("a bin row written before keys reads a null key name", () => {
      const s = setup();
      try {
        const file = s.area.create(s.projectId, s.author, "a.md", "one");
        s.area.remove(s.projectId, s.author, file.id);
        s.db.exec(
          "update knowledge_versions set file_snapshot = json_remove(file_snapshot, '$.author.keyName')",
        );
        const [binned] = s.area.list(s.projectId).deleted;
        expect(binned!.author).toEqual(s.author);
      } finally {
        s.db.close();
      }
    });
  });

  describe("edit", () => {
    const PLAN = "# Plan\n\n- one\n- two\n- three\n";

    test.serial(
      "applies as one version naming the key and updates an open page",
      () => {
        const s = setup();
        const key = keyed(s);
        try {
          const file = s.area.create(s.projectId, s.author, "plan.md", PLAN);
          s.now.value = 300;
          watched(s, (events) => {
            const edited = s.area.edit(s.projectId, key, file.id, 1, [
              { old: "- two", new: "- 2" },
              { old: "# Plan", new: "# Done" },
            ]);
            const read = s.area.read(s.projectId, file.id);
            expect(read.text).toBe("# Done\n\n- one\n- 2\n- three\n");
            const {
              text: _,
              language: __,
              html: ___,
              code: ____,
              ...row
            } = read;
            expect(edited).toEqual(row);
            expect(edited).toMatchObject({
              id: file.id,
              name: "plan.md",
              revision: 2,
              author: key,
              updatedAt: 300,
            });
            expect("text" in edited).toBe(false);
            expect(events.map((e) => e.data)).toEqual([
              { projectId: s.projectId, file: edited, deleted: false },
            ]);
          });
          const versions = s.area.versions(s.projectId, file.id);
          expect(versions.map((v) => [v.revision, v.author.keyName])).toEqual([
            [2, "laptop-claude"],
            [1, null],
          ]);
          expect(s.area.version(s.projectId, versions[0]!.id).text).toBe(
            "# Done\n\n- one\n- 2\n- three\n",
          );
        } finally {
          s.db.close();
        }
      },
    );

    test("reordering the pairs gives the same text", () => {
      const s = setup();
      try {
        const edits = [
          { old: "- one", new: "- 1" },
          { old: "three\n", new: "3\n- four\n" },
        ];
        const a = s.area.create(s.projectId, s.author, "a.md", PLAN);
        const b = s.area.create(s.projectId, s.author, "b.md", PLAN);
        s.area.edit(s.projectId, keyed(s), a.id, 1, edits);
        s.area.edit(s.projectId, keyed(s), b.id, 1, [...edits].reverse());
        expect(s.area.read(s.projectId, a.id).text).toBe(
          "# Plan\n\n- 1\n- two\n- 3\n- four\n",
        );
        expect(s.area.read(s.projectId, b.id).text).toBe(
          s.area.read(s.projectId, a.id).text,
        );
      } finally {
        s.db.close();
      }
    });

    test.each([
      ["no match", [{ old: "- four", new: "- 4" }], "edit 1: no match"],
      [
        "two matches",
        [
          { old: "Plan", new: "Done" },
          { old: "- t", new: "- T" },
        ],
        "edit 2: matches more than once",
      ],
      [
        "overlapping pairs",
        [
          { old: "- one\n- two", new: "x" },
          { old: "two\n- three", new: "y" },
        ],
        "edit 2: overlaps edit 1",
      ],
      [
        "an old only in another pair's new",
        [
          { old: "- one", new: "- four" },
          { old: "- four", new: "- 4" },
        ],
        "edit 2: no match",
      ],
      ["an empty old", [{ old: "", new: "x" }], "edit 1: old is empty"],
      [
        "a 51st pair",
        Array.from({ length: MAX_EDITS + 1 }, () => ({ old: "one", new: "1" })),
        "edits must hold 1 to 50 pairs",
      ],
    ])("refuses %s and writes nothing", (_, edits, words) => {
      const s = setup();
      try {
        const file = s.area.create(s.projectId, s.author, "plan.md", PLAN);
        const before = state(s, file.id);
        expect(() =>
          s.area.edit(s.projectId, keyed(s), file.id, 1, edits),
        ).toThrow(new BadRequest(words));
        expect(state(s, file.id)).toEqual(before);
      } finally {
        s.db.close();
      }
    });

    test("a stale revision answers the page's 409 and writes nothing", () => {
      const s = setup();
      try {
        const file = s.area.create(s.projectId, s.author, "plan.md", PLAN);
        s.area.replace(s.projectId, s.author, file.id, `${PLAN}- four\n`, 1);
        const before = state(s, file.id);
        expect(() =>
          s.area.edit(s.projectId, keyed(s), file.id, 1, [
            { old: "- one", new: "- 1" },
          ]),
        ).toThrow(new Conflict("plan.md is at revision 2"));
        expect(state(s, file.id)).toEqual(before);
      } finally {
        s.db.close();
      }
    });

    test("holds to replace's file cap", () => {
      const s = setup({ knowledgeFileBytes: PLAN.length + 2 });
      try {
        const file = s.area.create(s.projectId, s.author, "plan.md", PLAN);
        expect(() =>
          s.area.edit(s.projectId, keyed(s), file.id, 1, [
            { old: "- one", new: "- one, longer" },
          ]),
        ).toThrow(
          new BadRequest(
            `plan.md is ${PLAN.length + 8} bytes, the limit is ${PLAN.length + 2}`,
          ),
        );
        // a smaller result is a replace past a lowered cap, so it passes
        s.area.edit(s.projectId, keyed(s), file.id, 1, [
          { old: "- one\n", new: "" },
        ]);
        expect(s.area.read(s.projectId, file.id).revision).toBe(2);
      } finally {
        s.db.close();
      }
    });

    test.each([
      ["a NUL in new", "- one", "- \u0000"],
      ["a lone surrogate in new", "- one", "\ud800"],
      ["an old splitting a surrogate pair", "\ud83d", "x"],
    ])("refuses %s as a page replace would", (_, old, replacement) => {
      const s = setup();
      try {
        const file = s.area.create(
          s.projectId,
          s.author,
          "plan.md",
          `${PLAN}\u{1f600}\n`,
        );
        const before = state(s, file.id);
        expect(() =>
          s.area.edit(s.projectId, keyed(s), file.id, 1, [
            { old, new: replacement },
          ]),
        ).toThrow(new BadRequest("not a text file"));
        expect(state(s, file.id)).toEqual(before);
      } finally {
        s.db.close();
      }
    });

    test("strips a leading byte order mark as a page replace does", () => {
      const s = setup();
      try {
        const file = s.area.create(s.projectId, s.author, "plan.md", PLAN);
        const edited = s.area.edit(s.projectId, keyed(s), file.id, 1, [
          { old: "# Plan", new: "\ufeff# Plan" },
        ]);
        expect(s.area.read(s.projectId, file.id).text).toBe(PLAN);
        expect(edited.bytes).toBe(Buffer.byteLength(PLAN));
      } finally {
        s.db.close();
      }
    });
  });
});
