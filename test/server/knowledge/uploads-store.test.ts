// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import {
  MAX_STAGED_ITEMS,
  UPLOAD_LEASE_MS,
} from "../../../src/server/knowledge/limits.ts";
import type {
  StageInput,
  UploadCaps,
} from "../../../src/server/knowledge/uploads.ts";
import { subscribe } from "../../../src/server/lib/bus.ts";
import {
  BadRequest,
  Conflict,
  NotFound,
} from "../../../src/server/lib/errors.ts";
import { newId } from "../../../src/server/lib/ids.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { ProjectStore } from "../../../src/server/projects/index.ts";
import { createUser, UserStore } from "../../../src/server/users/index.ts";
import type { KnowledgeUploadResult } from "../../../src/shared/contracts/knowledge.ts";
import { MAX_UPLOAD_RECORD_BYTES } from "../../../src/shared/uploads.ts";
import { setup } from "./helpers.ts";

const blank = { revision: 0, bytes: 0, files: 0, entries: [] };
const file = (name: string, text = name) => ({ name, text });

function result(files: StageInput["files"]): KnowledgeUploadResult {
  return {
    added: files.length,
    replaced: 0,
    unchanged: 0,
    renamed: 0,
    saved: files.map((entry) => entry.name),
    skipped: [],
    skippedTotal: 0,
  };
}

function fixture() {
  const ctx = setup();
  const uploads = ctx.area.uploads;
  const userId = ctx.author.id;
  const stage = (
    files: StageInput["files"] = [file("note.md", "hello")],
    input: Partial<StageInput> = {},
    owner = userId,
    project = ctx.projectId,
    caps: UploadCaps = ctx.caps,
  ) =>
    transact(ctx.db, () => ({
      result: uploads.stage(
        owner,
        project,
        {
          attempt: newId(),
          name: "notes.zip",
          archive: true,
          folder: "",
          files,
          result: result(files),
          ...input,
        },
        caps,
        ctx.now.value,
      ),
    }));
  const list = () => uploads.list(userId, ctx.projectId, ctx.now.value);
  const claim = (
    ids: readonly string[],
    caps: UploadCaps = ctx.caps,
    messageId = "message-1",
    sessionId = ctx.session.id,
  ) =>
    transact(ctx.db, () => ({
      result: uploads.claim(
        userId,
        ctx.projectId,
        sessionId,
        messageId,
        ids,
        caps,
        ctx.now.value,
      ),
    }));
  const check = (ids: readonly string[]) =>
    uploads.check(userId, ctx.projectId, ids, ctx.now.value);
  const copy = (target = ctx.makeSession().id, caps: UploadCaps = ctx.caps) =>
    transact(ctx.db, () => ({
      result: uploads.copy(ctx.session.id, target, caps, ctx.now.value),
    }));
  const read = () => uploads.read(ctx.session.id);
  return { ...ctx, uploads, userId, stage, list, claim, check, copy, read };
}

type Fixture = ReturnType<typeof fixture>;

function anotherUser(ctx: Fixture) {
  const projects = new ProjectStore(ctx.db);
  const user = createUser(
    {
      db: ctx.db,
      store: new UserStore(ctx.db),
      projects: {
        createPersonal: (fields) => {
          projects.createPersonal(fields);
        },
      },
    },
    {
      username: `other-${newId()}`,
      fullName: "Other",
      email: `${newId()}@example.com`,
      role: "member",
      passwordHash: "unused",
      mustChangePassword: false,
      now: 0,
    },
  );
  return { userId: user.id, projectId: projects.personal(user.id)!.id };
}

describe("upload store", () => {
  test("an absent tree reads empty and does not create rows", () => {
    const ctx = fixture();
    try {
      expect(ctx.read()).toEqual(blank);
      expect(ctx.claim([])).toEqual([]);
      expect(ctx.db.query("select * from session_uploads").all()).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test("staging counts UTF-8 bytes and empty files, retaining the saved order", () => {
    const ctx = fixture();
    try {
      const files = [file("z.md", "é"), file("a.md", "")];
      const item = ctx.stage(files);
      expect(item).toEqual({
        id: expect.any(String),
        attempt: expect.any(String),
        name: "notes.zip",
        archive: true,
        folder: "",
        files: 2,
        bytes: 2,
        saved: ["z.md", "a.md"],
        skipped: [],
        skippedTotal: 0,
        renamed: 0,
        expiresAt: ctx.now.value + UPLOAD_LEASE_MS,
      });
      expect(ctx.list()).toEqual([item]);
      expect(
        ctx.db
          .query(
            "select position, name, bytes from upload_staged_files order by position",
          )
          .all(),
      ).toEqual([
        { position: 0, name: "z.md", bytes: 2 },
        { position: 1, name: "a.md", bytes: 0 },
      ]);
      expect(ctx.read()).toEqual(blank);
      expect(ctx.claim([item.id!])[0]!.saved).toEqual(["z.md", "a.md"]);
    } finally {
      ctx.db.close();
    }
  });

  test("bounds the stored display name, saved names and skipped results", () => {
    const ctx = fixture();
    try {
      const files = Array.from({ length: 250 }, (_, i) =>
        file(`file-${i}`, ""),
      );
      const judged = result(files);
      judged.renamed = 230;
      judged.skippedTotal = 260;
      judged.skipped = Array.from({ length: 260 }, (_, index) => ({
        index,
        name: "\u0001😀".repeat(200),
        reason: "not-text",
        other: index + 1,
      }));
      const item = ctx.stage(files, {
        name: "\u0001😀".repeat(200),
        result: judged,
      });
      expect(item.name.length).toBeLessThanOrEqual(200);
      expect(Buffer.byteLength(JSON.stringify(item.name))).toBeLessThanOrEqual(
        300,
      );
      expect(item.saved).toHaveLength(200);
      expect(item.skipped).toHaveLength(200);
      expect(item.skipped[199]).toEqual({
        ...judged.skipped[199]!,
        name: item.name,
      });
      expect(item).toMatchObject({
        files: 250,
        skippedTotal: 260,
        renamed: 230,
      });
      expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThan(128 * 1024);
      expect(ctx.list()).toEqual([item]);
      judged.saved.length = 0;
      item.skipped.length = 0;
      expect(ctx.list()[0]!.saved).toHaveLength(200);
      expect(ctx.list()[0]!.skipped).toHaveLength(200);
    } finally {
      ctx.db.close();
    }
  });

  test.each([0, 7])(
    "zero-file outcomes with %p skips create no rows",
    (skipped) => {
      const ctx = fixture();
      try {
        const judged = result([]);
        judged.skipped = Array.from({ length: skipped }, (_, index) => ({
          index,
          name: "binary",
          reason: "not-text",
        }));
        judged.skippedTotal = skipped;
        const item = ctx.stage([], { result: judged });
        expect(item).toMatchObject({
          id: null,
          expiresAt: null,
          files: 0,
          bytes: 0,
          skippedTotal: skipped,
        });
        expect(ctx.list()).toEqual([]);
        expect(ctx.db.query("select * from upload_staged").all()).toEqual([]);
        expect(ctx.db.query("select * from upload_staged_files").all()).toEqual(
          [],
        );
      } finally {
        ctx.db.close();
      }
    },
  );

  test("attempts are unique for the user even across projects", () => {
    const ctx = fixture();
    try {
      const other = anotherUser(ctx);
      const item = ctx.stage();
      expect(() => ctx.stage(undefined, { attempt: item.attempt })).toThrow(
        Conflict,
      );
      expect(() =>
        ctx.stage(
          undefined,
          { attempt: item.attempt },
          ctx.userId,
          other.projectId,
        ),
      ).toThrow(Conflict);
      expect(
        ctx.stage(undefined, { attempt: item.attempt }, other.userId).attempt,
      ).toBe(item.attempt);
      expect(ctx.list()).toEqual([item]);
    } finally {
      ctx.db.close();
    }
  });

  test("lists and removes only the owner's live rows in the project", () => {
    const ctx = fixture();
    try {
      const other = anotherUser(ctx);
      const own = ctx.stage();
      const theirs = ctx.stage(undefined, {}, other.userId);
      const elsewhere = ctx.stage(undefined, {}, ctx.userId, other.projectId);
      expect(ctx.list()).toEqual([own]);
      for (const id of [theirs.id!, elsewhere.id!, "missing"]) {
        expect(() =>
          ctx.uploads.remove(ctx.userId, ctx.projectId, id, ctx.now.value),
        ).toThrow(NotFound);
      }
      ctx.uploads.remove(ctx.userId, ctx.projectId, own.id!, ctx.now.value);
      expect(ctx.list()).toEqual([]);
      expect(
        ctx.db
          .query("select * from upload_staged_files where upload_id = ?")
          .all(own.id!),
      ).toEqual([]);
      expect(
        ctx.uploads.list(other.userId, ctx.projectId, ctx.now.value),
      ).toEqual([theirs]);
    } finally {
      ctx.db.close();
    }
  });

  test("the staged item count is isolated by both user and project", () => {
    const ctx = fixture();
    try {
      const other = anotherUser(ctx);
      for (let i = 0; i < MAX_STAGED_ITEMS; i++) ctx.stage();
      expect(() => ctx.stage()).toThrow("21 items, the limit is 20");
      expect(ctx.stage(undefined, {}, other.userId).id).not.toBeNull();
      expect(
        ctx.stage(undefined, {}, ctx.userId, other.projectId).id,
      ).not.toBeNull();
      expect(ctx.stage([]).id).toBeNull();
      expect(ctx.list()).toHaveLength(MAX_STAGED_ITEMS);
    } finally {
      ctx.db.close();
    }
  });

  test.each([
    {
      files: [file("one", "12345")],
      caps: { uploadBytes: 4 },
      words: "5 bytes, the limit is 4",
    },
    {
      files: Array.from({ length: 2000 }, (_, i) => file(`empty-${i}`, "")),
      caps: { uploadFiles: 1000 },
      words: "2000 files, the limit is 1000",
    },
  ])(
    "refuses an individual staged item above $words",
    ({ files, caps, words }) => {
      const ctx = fixture();
      try {
        expect(() =>
          ctx.stage(files, {}, ctx.userId, ctx.projectId, {
            ...ctx.caps,
            ...caps,
          }),
        ).toThrow(words);
        expect(ctx.list()).toEqual([]);
      } finally {
        ctx.db.close();
      }
    },
  );

  test.each([
    { caps: { uploadBytes: 9 }, words: "10 bytes, the limit is 9" },
    { caps: { uploadFiles: 1 }, words: "2 files, the limit is 1" },
  ])("staged totals enforce $words", ({ caps, words }) => {
    const ctx = fixture();
    try {
      const item = ctx.stage();
      expect(() =>
        ctx.stage(undefined, {}, ctx.userId, ctx.projectId, {
          ...ctx.caps,
          ...caps,
        }),
      ).toThrow(words);
      expect(ctx.list()).toEqual([item]);
    } finally {
      ctx.db.close();
    }
  });

  test("expired items are not listed or counted before the sweep", () => {
    const ctx = fixture();
    try {
      const items = Array.from({ length: MAX_STAGED_ITEMS }, () => ctx.stage());
      ctx.now.value += UPLOAD_LEASE_MS;
      expect(ctx.list()).toEqual([]);
      expect(() =>
        ctx.uploads.remove(
          ctx.userId,
          ctx.projectId,
          items[0]!.id!,
          ctx.now.value,
        ),
      ).toThrow(NotFound);
      expect(
        ctx.stage(undefined, {}, ctx.userId, ctx.projectId, {
          ...ctx.caps,
          uploadBytes: 5,
          uploadFiles: 1,
        }).files,
      ).toBe(1);
      expect(
        ctx.db.query("select count(*) as n from upload_staged").get(),
      ).toEqual({ n: MAX_STAGED_ITEMS + 1 });
    } finally {
      ctx.db.close();
    }
  });

  test("claims ordered items with later bytes and metadata winning", () => {
    const ctx = fixture();
    try {
      const first = ctx.stage([file("z", "first"), file("keep", "kept")]);
      const second = ctx.stage([file("z", "last")], {
        name: "z",
        archive: false,
      });
      const record = ctx.claim([first.id!, second.id!]);
      expect(record).toEqual([
        {
          name: "notes.zip",
          archive: true,
          files: 2,
          bytes: 9,
          saved: ["z", "keep"],
        },
        { name: "z", archive: false, files: 1, bytes: 4, saved: ["z"] },
      ]);
      expect(ctx.read()).toEqual({
        revision: 1,
        bytes: 8,
        files: 2,
        entries: [
          {
            name: "keep",
            text: "kept",
            bytes: 4,
            messageId: "message-1",
            item: "notes.zip",
            archive: true,
            createdAt: 100,
          },
          {
            name: "z",
            text: "last",
            bytes: 4,
            messageId: "message-1",
            item: "z",
            archive: false,
            createdAt: 100,
          },
        ],
      });
      expect(ctx.list()).toEqual([]);
      expect(ctx.db.query("select * from upload_staged_files").all()).toEqual(
        [],
      );
      ctx.now.value++;
      const replacement = ctx.stage([file("z", "new")]);
      ctx.claim([replacement.id!], ctx.caps, "message-2");
      expect(ctx.read()).toMatchObject({ revision: 2, bytes: 7, files: 2 });
      expect(ctx.read().entries[0]!.messageId).toBe("message-1");
      expect(ctx.read().entries[1]).toMatchObject({
        messageId: "message-2",
        item: "notes.zip",
        archive: true,
        createdAt: 101,
      });
      expect(ctx.uploads.read(ctx.makeSession().id)).toEqual(blank);
      expect(ctx.db.query("pragma foreign_key_check").all()).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test("id order, not staging order, determines the final replacement", () => {
    const ctx = fixture();
    try {
      const first = ctx.stage([file("same", "first")]);
      const second = ctx.stage([file("same", "second")]);
      ctx.claim([second.id!, first.id!]);
      expect(ctx.read().entries[0]!.text).toBe("first");
      expect(ctx.read().revision).toBe(1);
    } finally {
      ctx.db.close();
    }
  });

  test.each(["owner", "project", "expired", "duplicate", "missing", "claimed"])(
    "check and claim refuse a %s id",
    (kind) => {
      const ctx = fixture();
      try {
        const other = anotherUser(ctx);
        const item = ctx.stage();
        let ids = [item.id!];
        if (kind === "owner")
          ids = [ctx.stage(undefined, {}, other.userId).id!];
        if (kind === "project")
          ids = [ctx.stage(undefined, {}, ctx.userId, other.projectId).id!];
        if (kind === "expired") ctx.now.value += UPLOAD_LEASE_MS;
        if (kind === "duplicate") ids.push(ids[0]!);
        if (kind === "missing") ids = ["missing"];
        if (kind === "claimed") ctx.claim(ids);
        const before = ctx.read();
        const staged = ctx.list();
        expect(() => ctx.check(ids)).toThrow(BadRequest);
        expect(() => ctx.claim(ids)).toThrow(
          "an attached file is gone, add it again",
        );
        expect(ctx.read()).toEqual(before);
        expect(ctx.list()).toEqual(staged);
      } finally {
        ctx.db.close();
      }
    },
  );

  test("check and claim refuse more than ten distinct items", () => {
    const ctx = fixture();
    try {
      const ids = Array.from({ length: 11 }, () => ctx.stage().id!);
      expect(() => ctx.check(ids)).toThrow("at most 10");
      expect(() => ctx.claim(ids)).toThrow("at most 10");
      expect(ctx.read()).toEqual(blank);
      expect(ctx.list()).toHaveLength(11);
    } finally {
      ctx.db.close();
    }
  });

  test.each(["a", "a/b"])(
    "refuses both directions of a directory clash at %s",
    (name) => {
      const ctx = fixture();
      try {
        ctx.claim([ctx.stage([file(name)]).id!]);
        const before = ctx.read();
        const item = ctx.stage([file(name === "a" ? "a/b" : "a")]);
        expect(() => ctx.claim([item.id!])).toThrow(Conflict);
        expect(() => ctx.claim([item.id!])).toThrow(
          "clashes with an uploaded file",
        );
        expect(ctx.read()).toEqual(before);
        expect(ctx.list()).toEqual([item]);
      } finally {
        ctx.db.close();
      }
    },
  );

  test("a directory clash between staged items leaves both staged", () => {
    const ctx = fixture();
    try {
      const items = [ctx.stage([file("a/b")]), ctx.stage([file("a")])];
      expect(() => ctx.claim(items.map((item) => item.id!))).toThrow(Conflict);
      expect(ctx.read()).toEqual(blank);
      expect(ctx.list()).toEqual(items);
    } finally {
      ctx.db.close();
    }
  });

  test.each([
    { caps: { knowledgeFileBytes: 4 }, words: "5 bytes, the limit is 4" },
    { caps: { uploadBytes: 4 }, words: "5 bytes, the limit is 4" },
    { caps: { uploadFiles: 0 }, words: "1 files, the limit is 0" },
  ])("claim rechecks lowered caps: $words", ({ caps, words }) => {
    const ctx = fixture();
    try {
      const item = ctx.stage();
      ctx.check([item.id!]);
      expect(() => ctx.claim([item.id!], { ...ctx.caps, ...caps })).toThrow(
        words,
      );
      expect(ctx.list()).toEqual([item]);
      expect(ctx.read()).toEqual(blank);
    } finally {
      ctx.db.close();
    }
  });

  test("the claim tests merged totals, not the sum of every replacement", () => {
    const ctx = fixture();
    try {
      ctx.claim([ctx.stage([file("a", "old")]).id!]);
      const items = [
        ctx.stage([file("a", "longer")]),
        ctx.stage([file("a", "new")]),
      ];
      ctx.claim(
        items.map((item) => item.id!),
        { ...ctx.caps, uploadBytes: 3 },
      );
      expect(ctx.read()).toMatchObject({ bytes: 3, files: 1, revision: 2 });
    } finally {
      ctx.db.close();
    }
  });

  test("a claim can shrink a tree above both lowered total and file caps", () => {
    const ctx = fixture();
    try {
      ctx.claim([ctx.stage([file("a", "12345678"), file("b", "")]).id!]);
      const smaller = ctx.stage([file("a", "123456")]);
      const caps = {
        ...ctx.caps,
        uploadBytes: 4,
        uploadFiles: 1,
        knowledgeFileBytes: 4,
      };
      ctx.claim([smaller.id!], caps);
      expect(ctx.read()).toMatchObject({ files: 2, bytes: 6, revision: 2 });
      const same = ctx.stage([file("a", "654321")]);
      expect(() => ctx.claim([same.id!], caps)).toThrow(BadRequest);
      const larger = ctx.stage([file("a", "1234567")]);
      expect(() => ctx.claim([larger.id!], caps)).toThrow(BadRequest);
      expect(
        ctx.claim([], { ...caps, uploadBytes: 0, uploadFiles: 0 }),
      ).toEqual([]);
      expect(ctx.read()).toMatchObject({ files: 2, bytes: 6, revision: 2 });
    } finally {
      ctx.db.close();
    }
  });

  test("shrinking bytes does not allow growth in an over-limit file count", () => {
    const ctx = fixture();
    try {
      ctx.claim([ctx.stage([file("a", "12345678"), file("b", "")]).id!]);
      const item = ctx.stage([file("a", "1"), file("c", "")]);
      expect(() =>
        ctx.claim([item.id!], { ...ctx.caps, uploadFiles: 1 }),
      ).toThrow("3 files, the limit is 1");
      expect(ctx.read()).toMatchObject({ files: 2, bytes: 8, revision: 1 });
    } finally {
      ctx.db.close();
    }
  });

  test("same-size replacements cannot keep an over-limit total unchanged", () => {
    const ctx = fixture();
    try {
      ctx.claim([ctx.stage([file("a", "123456")]).id!]);
      const item = ctx.stage([file("a", "654321")]);
      expect(() =>
        ctx.claim([item.id!], { ...ctx.caps, uploadBytes: 4 }),
      ).toThrow("6 bytes, the limit is 4");
      expect(ctx.read().revision).toBe(1);
    } finally {
      ctx.db.close();
    }
  });

  test("claim refusals bound file names in their error words", () => {
    const ctx = fixture();
    try {
      const name = "a".repeat(1000);
      const item = ctx.stage([file(name, "hello")]);
      expect(() =>
        ctx.claim([item.id!], { ...ctx.caps, knowledgeFileBytes: 4 }),
      ).toThrow(`${"a".repeat(200)} is 5 bytes, the limit is 4`);
      ctx.claim([ctx.stage([file(`${name}/child`, "")]).id!]);
      let words = "";
      try {
        ctx.claim([item.id!]);
      } catch (error) {
        expect(error).toBeInstanceOf(Conflict);
        words = (error as Error).message;
      }
      expect(words).toBe(`${"a".repeat(200)} clashes with an uploaded file`);
      expect(Buffer.byteLength(JSON.stringify(words))).toBeLessThan(350);
    } finally {
      ctx.db.close();
    }
  });

  test.each(["removed", "expired"])(
    "claim rereads an item %s after preflight",
    (change) => {
      const ctx = fixture();
      try {
        const item = ctx.stage();
        ctx.check([item.id!]);
        if (change === "removed") {
          ctx.uploads.remove(
            ctx.userId,
            ctx.projectId,
            item.id!,
            ctx.now.value,
          );
        } else ctx.now.value = item.expiresAt!;
        expect(() => ctx.claim([item.id!])).toThrow(BadRequest);
        expect(ctx.read()).toEqual(blank);
      } finally {
        ctx.db.close();
      }
    },
  );

  test.serial(
    "a later transaction failure restores staging and tree without events",
    () => {
      const ctx = fixture();
      const events: string[] = [];
      const unsubscribe = subscribe((event) => events.push(event.type), silent);
      try {
        ctx.claim([ctx.stage([file("a", "before")]).id!]);
        const item = ctx.stage([file("a", "after"), file("b", "new")]);
        const before = ctx.read();
        expect(() =>
          transact(ctx.db, () => {
            ctx.uploads.claim(
              ctx.userId,
              ctx.projectId,
              ctx.session.id,
              "message-2",
              [item.id!],
              ctx.caps,
              ctx.now.value,
            );
            throw new Error("later write failed");
          }),
        ).toThrow("later write failed");
        expect(ctx.read()).toEqual(before);
        expect(ctx.list()).toEqual([item]);
        expect(events).toEqual([]);
      } finally {
        unsubscribe();
        ctx.db.close();
      }
    },
  );

  test("a failed first claim leaves no tree row", () => {
    const ctx = fixture();
    try {
      const item = ctx.stage();
      expect(() =>
        transact(ctx.db, () => {
          ctx.uploads.claim(
            ctx.userId,
            ctx.projectId,
            ctx.session.id,
            "message-1",
            [item.id!],
            ctx.caps,
            ctx.now.value,
          );
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(ctx.read()).toEqual(blank);
      expect(ctx.db.query("select * from session_uploads").all()).toEqual([]);
      expect(ctx.list()).toEqual([item]);
    } finally {
      ctx.db.close();
    }
  });

  test("staging and removing roll back in the caller's transaction", () => {
    const ctx = fixture();
    try {
      expect(() =>
        transact(ctx.db, () => {
          ctx.stage();
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(ctx.list()).toEqual([]);
      const item = ctx.stage();
      expect(() =>
        transact(ctx.db, () => {
          ctx.uploads.remove(
            ctx.userId,
            ctx.projectId,
            item.id!,
            ctx.now.value,
          );
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(ctx.list()).toEqual([item]);
    } finally {
      ctx.db.close();
    }
  });

  test("message records retain counts and archive flags within their byte bound", () => {
    const ctx = fixture();
    try {
      const paths = Array.from(
        { length: 25 },
        (_, i) =>
          `${"a".repeat(79)}/${"b".repeat(79)}/${"c".repeat(36)}${String(i).padStart(3, "0")}`,
      );
      const ids = Array.from(
        { length: 10 },
        (_, i) =>
          ctx.stage(
            paths.map((path) => file(path, "")),
            { name: "\u0001".repeat(200), archive: i % 2 === 0 },
          ).id!,
      );
      const record = ctx.claim(ids);
      expect(record).toHaveLength(10);
      expect(
        record.every((item) => item.files === 25 && item.bytes === 0),
      ).toBeTrue();
      expect(record.map((item) => item.archive)).toEqual(
        Array.from({ length: 10 }, (_, i) => i % 2 === 0),
      );
      expect(record[0]!.saved).toEqual(paths.slice(0, 20));
      expect(record.at(-1)!.saved.length).toBeLessThan(20);
      expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(
        MAX_UPLOAD_RECORD_BYTES,
      );
      expect(ctx.read()).toMatchObject({ files: 25, bytes: 0, revision: 1 });
    } finally {
      ctx.db.close();
    }
  });

  test("copy retains the complete tree, metadata and session isolation", () => {
    const ctx = fixture();
    try {
      ctx.claim([ctx.stage([file("a", "first")]).id!]);
      ctx.claim(
        [ctx.stage([file("b", "later")], { archive: false }).id!],
        ctx.caps,
        "message-2",
      );
      const source = ctx.read();
      const target = ctx.makeSession().id;
      expect(ctx.copy(target, { ...ctx.caps, knowledgeFileBytes: 1 })).toEqual(
        [],
      );
      expect(ctx.uploads.read(target)).toEqual({ ...source, revision: 1 });
      ctx.claim([ctx.stage([file("a", "changed")]).id!]);
      expect(ctx.uploads.read(target)).toEqual({ ...source, revision: 1 });
      ctx.sessions.delete(ctx.session.id);
      expect(ctx.read()).toEqual(blank);
      expect(ctx.uploads.read(target)).toEqual({ ...source, revision: 1 });
      ctx.sessions.delete(target);
      expect(ctx.db.query("select * from session_uploads").all()).toEqual([]);
      expect(ctx.db.query("select * from session_upload_files").all()).toEqual(
        [],
      );
    } finally {
      ctx.db.close();
    }
  });

  test.each([{ uploadBytes: 4 }, { uploadFiles: 0 }])(
    "copy refuses current total caps %p without writing",
    (caps) => {
      const ctx = fixture();
      try {
        ctx.claim([ctx.stage().id!]);
        const target = ctx.makeSession().id;
        expect(() => ctx.copy(target, { ...ctx.caps, ...caps })).toThrow(
          BadRequest,
        );
        expect(ctx.uploads.read(target)).toEqual(blank);
        expect(ctx.read()).toMatchObject({ bytes: 5, files: 1, revision: 1 });
      } finally {
        ctx.db.close();
      }
    },
  );

  test("copy and a newly made session roll back after a later failure", () => {
    const ctx = fixture();
    let target = "";
    try {
      ctx.claim([ctx.stage().id!]);
      const before = ctx.read();
      expect(() =>
        transact(ctx.db, () => {
          target = ctx.makeSession().id;
          ctx.uploads.copy(ctx.session.id, target, ctx.caps, ctx.now.value);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(ctx.sessions.byId(target)).toBeNull();
      expect(ctx.uploads.read(target)).toEqual(blank);
      expect(ctx.read()).toEqual(before);
    } finally {
      ctx.db.close();
    }
  });

  test("copy does not overwrite a target that already holds a tree", () => {
    const ctx = fixture();
    try {
      ctx.claim([ctx.stage().id!]);
      const target = ctx.makeSession().id;
      ctx.copy(target);
      expect(() => ctx.copy(target)).toThrow(Conflict);
    } finally {
      ctx.db.close();
    }
  });

  test("copy of an empty source leaves no upload tree", () => {
    const ctx = fixture();
    try {
      const target = ctx.makeSession().id;
      expect(ctx.copy(target)).toEqual([]);
      expect(ctx.uploads.read(target)).toEqual(blank);
      expect(ctx.db.query("select * from session_uploads").all()).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test("copy restages one turn's remaining items under fresh leases", () => {
    const ctx = fixture();
    try {
      ctx.claim([ctx.stage([file("keep", "previous")]).id!], ctx.caps, "older");
      ctx.claim(
        [
          ctx.stage([file("docs/a", "old"), file("docs/b", "current")]).id!,
          ctx.stage([file("note", "loose")], { name: "note", archive: false })
            .id!,
        ],
        ctx.caps,
        "picked",
      );
      ctx.claim([ctx.stage([file("docs/a", "new")]).id!], ctx.caps, "later");
      for (let i = 0; i < MAX_STAGED_ITEMS; i++) ctx.stage();
      ctx.now.value = 500;
      const target = ctx.makeSession().id;
      const ids = transact(ctx.db, () => ({
        result: ctx.uploads.copy(
          ctx.session.id,
          target,
          ctx.caps,
          ctx.now.value,
          {
            userId: ctx.userId,
            projectId: ctx.projectId,
            messageId: "picked",
          },
        ),
      }));
      expect(ids).toHaveLength(2);
      const items = ctx.list().filter((item) => ids.includes(item.id!));
      expect(
        items.map((item) => [item.name, item.archive, item.saved]),
      ).toEqual([
        ["notes.zip", true, ["docs/b"]],
        ["note", false, ["note"]],
      ]);
      expect(
        items.every((item) => item.expiresAt === 500 + UPLOAD_LEASE_MS),
      ).toBeTrue();
      expect(
        ctx.uploads.read(target).entries.map((entry) => entry.name),
      ).toEqual(["docs/a", "keep"]);
      ctx.claim(ids, ctx.caps, "edited", target);
      expect(ctx.uploads.read(target)).toMatchObject({ files: 4, revision: 2 });
      expect(
        ctx.uploads.read(target).entries.find((entry) => entry.name === "note"),
      ).toMatchObject({ messageId: "edited", item: "note", archive: false });
      expect(
        ctx.read().entries.find((entry) => entry.name === "note")!.messageId,
      ).toBe("picked");
    } finally {
      ctx.db.close();
    }
  });

  test.each([
    {
      label: "same-name archives remain separate",
      items: [
        { name: "docs.zip", saved: ["docs/z.md"] },
        { name: "docs.zip", saved: ["docs/a.md"] },
      ],
      replaced: [],
    },
    {
      label: "item order is not lexical file order",
      items: [
        { name: "z.zip", saved: ["z/readme.md"] },
        { name: "a.zip", saved: ["a/readme.md"] },
      ],
      replaced: [],
    },
    {
      label: "each item's saved order survives partial replacement",
      items: [
        { name: "docs.zip", saved: ["docs/z.md", "docs/m.md", "docs/a.md"] },
      ],
      replaced: ["docs/m.md"],
    },
    {
      label: "fully replaced items leave no staged item",
      items: [
        { name: "gone.zip", saved: ["gone/a.md"] },
        { name: "docs.zip", saved: ["docs/z.md", "docs/a.md"] },
      ],
      replaced: ["gone/a.md"],
    },
    {
      label: "a fully replaced turn leaves no staged items",
      items: [{ name: "gone.zip", saved: ["gone/a.md"] }],
      replaced: ["gone/a.md"],
    },
  ])(
    "restaging preserves original attachments: $label",
    ({ items, replaced }) => {
      const ctx = fixture();
      try {
        const staged = items.toReversed().map((item) =>
          ctx.stage(
            item.saved.map((name) => file(name)),
            { name: item.name },
          ),
        );
        ctx.claim(
          staged.toReversed().map((item) => item.id!),
          ctx.caps,
          "picked",
        );
        if (replaced.length > 0) {
          ctx.claim(
            [ctx.stage(replaced.map((name) => file(name, "new"))).id!],
            ctx.caps,
            "later",
          );
        }
        const replacedNames = new Set<string>(replaced);
        const expected = items
          .map((item) => ({
            ...item,
            saved: item.saved.filter((name) => !replacedNames.has(name)),
          }))
          .filter((item) => item.saved.length > 0);
        const target = ctx.makeSession().id;
        const ids = transact(ctx.db, () => ({
          result: ctx.uploads.copy(
            ctx.session.id,
            target,
            ctx.caps,
            ctx.now.value,
            {
              userId: ctx.userId,
              projectId: ctx.projectId,
              messageId: "picked",
            },
          ),
        }));
        const byId = new Map(ctx.list().map((item) => [item.id, item]));
        expect(ids.map((id) => byId.get(id))).toEqual(
          expected.map((item) =>
            expect.objectContaining({
              name: item.name,
              archive: true,
              saved: item.saved,
              files: item.saved.length,
            }),
          ),
        );
        expect(ctx.claim(ids, ctx.caps, "edited", target)).toEqual(
          expected.map((item) =>
            expect.objectContaining({
              name: item.name,
              archive: true,
              saved: item.saved,
              files: item.saved.length,
            }),
          ),
        );
        expect(ctx.uploads.read(target).files).toBe(ctx.read().files);
      } finally {
        ctx.db.close();
      }
    },
  );

  test("copy remaps message ids so a copied turn can be restaged again", () => {
    const ctx = fixture();
    try {
      ctx.claim(
        [
          ctx.stage([file("docs/z"), file("docs/m")]).id!,
          ctx.stage([file("docs/a")]).id!,
        ],
        ctx.caps,
        "picked",
      );
      ctx.claim([ctx.stage([file("later")]).id!], ctx.caps, "later");
      const source = ctx.read();
      const fork = ctx.makeSession().id;
      expect(
        transact(ctx.db, () => ({
          result: ctx.area.copyUploads(
            ctx.session.id,
            fork,
            undefined,
            new Map([["picked", "copied-picked"]]),
          ),
        })),
      ).toEqual([]);
      expect(ctx.uploads.read(fork).entries).toEqual(
        source.entries.map((entry) => ({
          ...entry,
          messageId:
            entry.messageId === "picked" ? "copied-picked" : entry.messageId,
        })),
      );
      const target = ctx.makeSession().id;
      const ids = transact(ctx.db, () => ({
        result: ctx.area.copyUploads(
          fork,
          target,
          {
            userId: ctx.userId,
            projectId: ctx.projectId,
            messageId: "copied-picked",
          },
          new Map([
            ["copied-picked", "unused-picked"],
            ["later", "copied-later"],
          ]),
        ),
      }));
      const byId = new Map(ctx.list().map((item) => [item.id, item]));
      expect(ids.map((id) => byId.get(id)!.saved)).toEqual([
        ["docs/z", "docs/m"],
        ["docs/a"],
      ]);
      expect(ctx.uploads.read(target).entries).toEqual([
        { ...source.entries.at(-1)!, messageId: "copied-later" },
      ]);
      expect(ctx.read()).toEqual(source);
    } finally {
      ctx.db.close();
    }
  });

  test("restaging and the copied tree roll back together", () => {
    const ctx = fixture();
    try {
      ctx.claim([ctx.stage([file("keep")]).id!], ctx.caps, "older");
      ctx.claim([ctx.stage().id!], ctx.caps, "picked");
      const target = ctx.makeSession().id;
      expect(() =>
        transact(ctx.db, () => {
          ctx.uploads.copy(ctx.session.id, target, ctx.caps, ctx.now.value, {
            userId: ctx.userId,
            projectId: ctx.projectId,
            messageId: "picked",
          });
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(ctx.uploads.read(target)).toEqual(blank);
      expect(ctx.list()).toEqual([]);
      expect(ctx.read().files).toBe(2);
    } finally {
      ctx.db.close();
    }
  });

  test.each(["user", "project"])(
    "staged rows and files cascade with their %s",
    (kind) => {
      const ctx = fixture();
      try {
        const other = anotherUser(ctx);
        ctx.stage();
        const remaining = ctx.stage(
          undefined,
          {},
          other.userId,
          other.projectId,
        );
        ctx.db
          .query(
            kind === "user"
              ? "delete from users where id = ?"
              : "delete from projects where id = ?",
          )
          .run(kind === "user" ? ctx.userId : ctx.projectId);
        expect(ctx.db.query("select id from upload_staged").all()).toEqual([
          { id: remaining.id },
        ]);
        expect(
          ctx.db.query("select upload_id from upload_staged_files").all(),
        ).toEqual([{ upload_id: remaining.id }]);
        expect(ctx.db.query("pragma foreign_key_check").all()).toEqual([]);
      } finally {
        ctx.db.close();
      }
    },
  );

  test("deleting a project cascades its claimed uploads", () => {
    const ctx = fixture();
    try {
      ctx.claim([ctx.stage().id!]);
      ctx.db.query("delete from projects where id = ?").run(ctx.projectId);
      expect(ctx.read()).toEqual(blank);
      expect(ctx.db.query("select * from session_upload_files").all()).toEqual(
        [],
      );
    } finally {
      ctx.db.close();
    }
  });

  test("sweeps leases at expiry with their files, never claimed uploads", () => {
    const ctx = fixture();
    try {
      ctx.claim([ctx.stage().id!]);
      const expired = ctx.stage();
      ctx.now.value++;
      const live = ctx.stage();
      expect(ctx.uploads.sweep(expired.expiresAt!)).toBe(1);
      expect(
        ctx.uploads.list(ctx.userId, ctx.projectId, expired.expiresAt!),
      ).toEqual([live]);
      expect(
        ctx.db.query("select upload_id from upload_staged_files").all(),
      ).toEqual([{ upload_id: live.id }]);
      expect(ctx.uploads.sweep(live.expiresAt!)).toBe(1);
      expect(ctx.uploads.sweep(live.expiresAt!)).toBe(0);
      expect(ctx.read()).toMatchObject({ files: 1, bytes: 5, revision: 1 });
    } finally {
      ctx.db.close();
    }
  });

  test("the schema indexes owners and expiry and refuses orphan files", () => {
    const ctx = fixture();
    try {
      expect(
        ctx.db.query("pragma index_info(upload_staged_owner)").all(),
      ).toMatchObject([{ name: "user_id" }, { name: "project_id" }]);
      expect(
        ctx.db.query("pragma index_info(upload_staged_expiry)").all(),
      ).toMatchObject([{ name: "expires_at" }]);
      expect(ctx.db.query("pragma table_info(messages)").all()).toContainEqual(
        expect.objectContaining({ name: "uploads", type: "TEXT", notnull: 0 }),
      );
      expect(() =>
        ctx.db
          .query(
            "insert into upload_staged_files values ('missing', 0, 'a', '', 0)",
          )
          .run(),
      ).toThrow("FOREIGN KEY constraint failed");
      expect(() =>
        ctx.db
          .query(
            `insert into session_upload_files
             (session_id, name, text, bytes, message_id, item, archive, folder, created_at)
             values ('missing', 'a', '', 0, 'message', 'a', 0, '', 0)`,
          )
          .run(),
      ).toThrow("FOREIGN KEY constraint failed");
    } finally {
      ctx.db.close();
    }
  });
});
