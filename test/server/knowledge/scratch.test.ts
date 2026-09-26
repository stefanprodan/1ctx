// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import type {
  ScratchChanges,
  ScratchFile,
} from "../../../src/server/knowledge/index.ts";
import { Conflict } from "../../../src/server/lib/errors.ts";
import { setup } from "./helpers.ts";

const binary: ScratchFile = {
  path: "work/data.bin",
  data: new Uint8Array([0, 255, 128, 192, 10, 13, 1, 254]),
  mode: 0o600,
};
const empty: ScratchFile = {
  path: "empty",
  data: new Uint8Array(),
  mode: 0o755,
};
const blank = {
  cwd: "/knowledge",
  revision: 0,
  bytes: 0,
  files: 0,
  entries: [],
};

function write(
  ctx: ReturnType<typeof setup>,
  revision: number,
  changes: Partial<ScratchChanges> = {},
  sessionId = ctx.session.id,
) {
  transact(ctx.db, () => ({
    result: ctx.area.scratch.write(
      sessionId,
      revision,
      { written: [], removed: [], cwd: "/knowledge", ...changes },
      ctx.now.value,
    ),
  }));
}

function usedAt(ctx: ReturnType<typeof setup>) {
  return ctx.db
    .query<{ used_at: number }, [string]>(
      "select used_at from session_scratch where session_id = ?",
    )
    .get(ctx.session.id);
}

describe("scratch store", () => {
  test("an absent scratch reads empty without creating a row", () => {
    const ctx = setup();
    try {
      expect(ctx.area.scratch.read(ctx.session.id)).toEqual(blank);
      expect(ctx.db.query("select * from session_scratch").all()).toEqual([]);
      expect(ctx.db.query("select * from session_scratch_files").all()).toEqual(
        [],
      );
    } finally {
      ctx.db.close();
    }
  });

  test("round-trips binary bytes, empty blobs, modes and the directory", () => {
    const ctx = setup();
    try {
      write(ctx, 0, { written: [binary, empty], cwd: "/tmp/work" });
      const scratch = ctx.area.scratch.read(ctx.session.id);
      expect(scratch).toEqual({
        cwd: "/tmp/work",
        revision: 1,
        bytes: binary.data.byteLength,
        files: 2,
        entries: [empty, binary],
      });
      expect(scratch.entries[1]!.data).toBeInstanceOf(Uint8Array);
      expect([...scratch.entries[1]!.data]).toEqual([...binary.data]);
      expect(
        ctx.db
          .query("select typeof(data) as type from session_scratch_files")
          .all(),
      ).toEqual([{ type: "blob" }, { type: "blob" }]);
      expect(usedAt(ctx)).toEqual({ used_at: 100 });
      expect(ctx.db.query("pragma foreign_key_check").all()).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test("updates existing bytes and modes without replacing untouched files", () => {
    const ctx = setup();
    try {
      write(ctx, 0, { written: [binary, empty] });
      const changed = { ...binary, data: new Uint8Array([255, 0]) };
      ctx.now.value = 200;
      write(ctx, 1, { written: [changed], cwd: "/tmp" });
      expect(ctx.area.scratch.read(ctx.session.id)).toEqual({
        cwd: "/tmp",
        revision: 2,
        bytes: 2,
        files: 2,
        entries: [empty, changed],
      });
      const executable = { ...changed, mode: 0o700 };
      write(ctx, 2, { written: [executable], cwd: "/tmp" });
      expect(ctx.area.scratch.read(ctx.session.id)).toEqual({
        cwd: "/tmp",
        revision: 3,
        bytes: 2,
        files: 2,
        entries: [empty, executable],
      });
      expect(usedAt(ctx)).toEqual({ used_at: 200 });
    } finally {
      ctx.db.close();
    }
  });

  test("empty changes still advance the revision and last use", () => {
    const ctx = setup();
    try {
      write(ctx, 0);
      expect(ctx.area.scratch.read(ctx.session.id)).toEqual({
        ...blank,
        revision: 1,
      });
      ctx.now.value = 200;
      write(ctx, 1, { cwd: "/tmp" });
      ctx.now.value = 300;
      write(ctx, 2, { cwd: "/tmp" });
      expect(ctx.area.scratch.read(ctx.session.id)).toEqual({
        ...blank,
        cwd: "/tmp",
        revision: 3,
      });
      expect(usedAt(ctx)).toEqual({ used_at: 300 });
    } finally {
      ctx.db.close();
    }
  });

  test.each([0, 2])(
    "refuses revision %p when the scratch is at 1",
    (revision) => {
      const ctx = setup();
      try {
        write(ctx, 0, { written: [binary], cwd: "/tmp/work" });
        const before = ctx.area.scratch.read(ctx.session.id);
        ctx.now.value = 200;
        const fail = () =>
          write(ctx, revision, {
            written: [empty],
            removed: [binary.path],
            cwd: "/tmp",
          });
        expect(fail).toThrow(Conflict);
        expect(fail).toThrow("the scratch changed while the command ran");
        expect(ctx.area.scratch.read(ctx.session.id)).toEqual(before);
        expect(usedAt(ctx)).toEqual({ used_at: 100 });
      } finally {
        ctx.db.close();
      }
    },
  );

  test("refuses a nonzero revision when the scratch is absent", () => {
    const ctx = setup();
    try {
      expect(() => write(ctx, 1, { written: [binary] })).toThrow(Conflict);
      expect(ctx.area.scratch.read(ctx.session.id)).toEqual(blank);
      expect(usedAt(ctx)).toBeNull();
    } finally {
      ctx.db.close();
    }
  });

  test("removes paths and recounts without touching another session", () => {
    const ctx = setup();
    try {
      const second = ctx.makeSession();
      write(ctx, 0, { written: [binary, empty] });
      expect(ctx.area.scratch.read(second.id)).toEqual(blank);
      write(ctx, 0, { written: [binary] }, second.id);
      write(ctx, 1, { removed: [binary.path] });
      expect(ctx.area.scratch.read(ctx.session.id)).toEqual({
        ...blank,
        revision: 2,
        files: 1,
        entries: [empty],
      });
      write(ctx, 2, { removed: [empty.path] });
      expect(ctx.area.scratch.read(ctx.session.id)).toEqual({
        ...blank,
        revision: 3,
      });
      expect(ctx.area.scratch.read(second.id)).toEqual({
        ...blank,
        revision: 1,
        bytes: binary.data.byteLength,
        files: 1,
        entries: [binary],
      });
    } finally {
      ctx.db.close();
    }
  });

  test.each([false, true])(
    "rolls back with its caller, existing row %p",
    (existing) => {
      const ctx = setup();
      try {
        if (existing) write(ctx, 0, { written: [binary], cwd: "/tmp/work" });
        const before = ctx.area.scratch.read(ctx.session.id);
        const lastUse = usedAt(ctx);
        expect(() =>
          transact(ctx.db, () => {
            ctx.area.scratch.write(
              ctx.session.id,
              before.revision,
              { written: [empty], removed: [binary.path], cwd: "/tmp" },
              200,
            );
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(ctx.area.scratch.read(ctx.session.id)).toEqual(before);
        expect(usedAt(ctx)).toEqual(lastUse);
      } finally {
        ctx.db.close();
      }
    },
  );

  test("session deletion cascades to the scratch and all its files", () => {
    const ctx = setup();
    try {
      write(ctx, 0, { written: [binary, empty] });
      expect(ctx.sessions.remove(ctx.session.id)).toMatchObject({
        type: "session.deleted",
      });
      expect(ctx.db.query("select * from session_scratch").all()).toEqual([]);
      expect(ctx.db.query("select * from session_scratch_files").all()).toEqual(
        [],
      );
      expect(ctx.db.query("pragma foreign_key_check").all()).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test("sweeps expired rows with their files, keeping the boundary and newer rows", () => {
    const ctx = setup();
    try {
      const boundary = ctx.makeSession();
      const recent = ctx.makeSession();
      write(ctx, 0, { written: [binary, empty] });
      ctx.now.value = 101;
      write(ctx, 0, { written: [binary] }, boundary.id);
      ctx.now.value = 200;
      write(ctx, 0, { written: [empty] }, recent.id);
      const held = new Set<string>();
      expect(ctx.area.scratch.sweep(101 + 86_400_000, 1, held)).toBe(1);
      expect(ctx.area.scratch.read(ctx.session.id)).toEqual(blank);
      expect(usedAt(ctx)).toBeNull();
      expect(ctx.area.scratch.read(boundary.id).entries).toEqual([binary]);
      expect(ctx.area.scratch.read(recent.id).entries).toEqual([empty]);
      expect(ctx.sessions.byId(ctx.session.id)).not.toBeNull();
      expect(ctx.area.scratch.sweep(102 + 86_400_000, 1, held)).toBe(1);
      expect(ctx.area.scratch.read(boundary.id)).toEqual(blank);
      expect(ctx.area.scratch.sweep(201 + 86_400_000, 1, held)).toBe(1);
      expect(ctx.db.query("select * from session_scratch").all()).toEqual([]);
      expect(ctx.db.query("select * from session_scratch_files").all()).toEqual(
        [],
      );
    } finally {
      ctx.db.close();
    }
  });

  test("skips a held session until it is released", () => {
    const ctx = setup();
    try {
      const second = ctx.makeSession();
      write(ctx, 0, { written: [binary], cwd: "/tmp/work" });
      write(ctx, 0, { written: [empty] }, second.id);
      const before = ctx.area.scratch.read(ctx.session.id);
      const held = new Set([ctx.session.id]);
      expect(ctx.area.scratch.sweep(101 + 7 * 86_400_000, 7, held)).toBe(1);
      expect(ctx.area.scratch.read(ctx.session.id)).toEqual(before);
      expect(usedAt(ctx)).toEqual({ used_at: 100 });
      expect(ctx.area.scratch.read(second.id)).toEqual(blank);
      held.clear();
      expect(ctx.area.scratch.sweep(101 + 7 * 86_400_000, 7, held)).toBe(1);
      expect(ctx.area.scratch.read(ctx.session.id)).toEqual(blank);
      expect(usedAt(ctx)).toBeNull();
    } finally {
      ctx.db.close();
    }
  });

  test("the schema refuses orphan rows and indexes last use", () => {
    const ctx = setup();
    try {
      expect(() => write(ctx, 0, {}, "missing")).toThrow(
        "FOREIGN KEY constraint failed",
      );
      expect(() =>
        ctx.db
          .query("insert into session_scratch_files values (?, ?, ?, ?)")
          .run(ctx.session.id, binary.path, binary.data, binary.mode),
      ).toThrow("FOREIGN KEY constraint failed");
      expect(
        ctx.db.query("pragma index_info(session_scratch_used)").all(),
      ).toEqual([expect.objectContaining({ name: "used_at" })]);
    } finally {
      ctx.db.close();
    }
  });
});
