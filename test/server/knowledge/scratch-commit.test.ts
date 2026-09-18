// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { callCaps, run, scratchState, seedScratch, setup } from "./helpers.ts";

const edits =
  "echo changed > /knowledge/existing; echo draft > /tmp/new; cd /tmp";

function prepared() {
  const s = setup();
  const file = s.area.create(s.projectId, s.author, "existing", "original");
  seedScratch(s, {
    cwd: "/tmp/work",
    written: [
      { path: "work/kept", data: new Uint8Array([0, 255]), mode: 0o600 },
    ],
  });
  const before = scratchState(s);
  const knowledge = s.area.list(s.projectId);
  const versions = s.area.versions(s.projectId, file.id);
  s.now.value = 200;
  const unchanged = () => {
    expect(scratchState(s)).toEqual(before);
    expect(s.area.list(s.projectId)).toEqual(knowledge);
    expect(s.area.versions(s.projectId, file.id)).toEqual(versions);
    expect(s.area.read(s.projectId, file.id).text).toBe("original");
  };
  return { ...s, file, before, unchanged };
}

describe("atomic knowledge and scratch commits", () => {
  test.each([
    ["deadline exit", "exit 124", "nothing saved"],
    ["limit exit", "exit 126", "nothing saved"],
    ["loop limit", "while true; do :; done", "exit 126"],
    ["name", "touch '/tmp/bad name'", "name must be"],
    ["long segment", `touch /tmp/${"x".repeat(81)}`, "at most 80"],
    [
      "long name",
      `touch /tmp/${"a".repeat(70)}/${"b".repeat(70)}/${"c".repeat(70)}`,
      "200 total",
    ],
    [
      "depth nine",
      "mkdir -p /tmp/a/b/c/d/e/f/g/h; touch /tmp/a/b/c/d/e/f/g/h/i",
      "1 to 8 path segments",
    ],
    ["control character", "touch $'/tmp/bad\\nname'", "name must be"],
    ["long path", `touch /tmp/${"x".repeat(252)}`, "name must be"],
    ["root file", "rm -rf /tmp; echo file > /tmp", "/tmp is not a directory"],
    [
      "root symlink",
      "rm -rf /tmp; ln -s /knowledge /tmp",
      "/tmp is not a directory",
    ],
    ["removed root", "rm -rf /tmp", "ENOENT"],
    ["symlink", "ln -s /knowledge/existing /tmp/link", "not a regular file"],
    [
      "receipt overflow",
      "for i in {1..100}; do touch /knowledge/file$i; done",
      "change receipts exceed",
    ],
  ])(
    "%s saves neither tree, cwd nor last use",
    async (_label, command, words) => {
      const s = prepared();
      try {
        const result = await run(s, `${edits}; ${command}`);
        expect(result.error).toBe(true);
        expect(result.content).toContain(words);
        s.unchanged();
      } finally {
        s.db.close();
      }
    },
  );

  test("an abort after mounting saves nothing", async () => {
    const s = prepared();
    const controller = new AbortController();
    const pending = run(s, `${edits}; sleep 1`, callCaps, controller.signal);
    try {
      await Bun.sleep(30);
      controller.abort(new Error("send stopped"));
      expect(await pending).toEqual({
        error: true,
        content: "nothing saved: send stopped",
      });
      s.unchanged();
    } finally {
      controller.abort();
      await pending;
      s.db.close();
    }
  });

  test("a call deadline leaves both trees and last use untouched", async () => {
    const s = prepared();
    try {
      const result = await run(s, `${edits}; sleep 1`, {
        ...callCaps,
        callTimeoutMs: 30,
      });
      expect(result.error).toBe(true);
      s.unchanged();
    } finally {
      s.db.close();
    }
  });

  test("a throw after scratch writes rolls back both trees and releases the session", async () => {
    const s = prepared();
    const write = s.area.scratch.write.bind(s.area.scratch);
    s.area.scratch.write = (...args) => {
      write(...args);
      throw new Error("write failed");
    };
    try {
      expect(await run(s, edits)).toEqual({
        error: true,
        content: "nothing saved: write failed",
      });
      s.unchanged();
      s.area.scratch.write = write;
      expect((await run(s, edits)).error).toBe(false);
      expect(scratchState(s)).toMatchObject({
        revision: 2,
        cwd: "/tmp",
        usedAt: 200,
      });
    } finally {
      s.db.close();
    }
  });

  test("a knowledge revision conflict preserves the prior scratch", async () => {
    const s = prepared();
    const read = s.area.store.read.bind(s.area.store);
    s.area.store.read = (id) => {
      const rows = read(id);
      s.area.replace(s.projectId, s.author, s.file.id, "other writer", 1);
      return rows;
    };
    try {
      expect((await run(s, edits)).content).toContain(
        "existing changed while the command ran",
      );
      expect(scratchState(s)).toEqual(s.before);
      expect(s.area.read(s.projectId, s.file.id).text).toBe("other writer");
      expect(s.area.versions(s.projectId, s.file.id)).toHaveLength(2);
    } finally {
      s.db.close();
    }
  });

  test("a scratch revision conflict rolls back knowledge and preserves the racing scratch", async () => {
    const s = prepared();
    const read = s.area.scratch.read.bind(s.area.scratch);
    let raced = false;
    s.area.scratch.read = (id) => {
      const before = read(id);
      if (!raced) {
        raced = true;
        seedScratch(s, { cwd: "/tmp" });
      }
      return before;
    };
    try {
      expect((await run(s, edits)).content).toContain(
        "the scratch changed while the command ran",
      );
      expect(scratchState(s)).toEqual({
        ...s.before,
        cwd: "/tmp",
        revision: 2,
        usedAt: 200,
      });
      expect(s.area.read(s.projectId, s.file.id).text).toBe("original");
      expect(s.area.versions(s.projectId, s.file.id)).toHaveLength(1);
    } finally {
      s.db.close();
    }
  });

  test("an ordinary nonzero exit commits both trees and cwd", async () => {
    const s = prepared();
    try {
      expect(await run(s, `${edits}; false`)).toEqual({
        error: true,
        content: "exit 1\nwrote existing (rev 2, 1 lines)",
      });
      expect(scratchState(s)).toMatchObject({
        revision: 2,
        cwd: "/tmp",
        usedAt: 200,
        files: 2,
      });
      expect(s.area.read(s.projectId, s.file.id).text).toBe("changed\n");
    } finally {
      s.db.close();
    }
  });

  test.serial(
    "scratch-only, cwd-only and read-only commands commit without knowledge events",
    async () => {
      const s = setup();
      const events: BusEvent[] = [];
      const off = subscribe((event) => {
        if (
          event.type === "knowledge.changed" &&
          event.data.projectId === s.projectId
        )
          events.push(event);
      });
      try {
        for (const [i, command] of [
          "echo draft > /tmp/file",
          "cd /tmp",
          "cat file",
        ].entries()) {
          s.now.value = 100 + i;
          expect((await run(s, command)).error).toBe(false);
          expect(scratchState(s)).toMatchObject({
            revision: i + 1,
            usedAt: s.now.value,
            files: 1,
          });
        }
        expect(events).toEqual([]);
        expect(s.area.list(s.projectId).files).toEqual([]);
      } finally {
        off();
        s.db.close();
      }
    },
  );

  test.serial(
    "receipt overflow rolls back scratch edits and removals without events",
    async () => {
      const s = prepared();
      const events: BusEvent[] = [];
      const off = subscribe((event) => {
        if (
          event.type === "knowledge.changed" &&
          event.data.projectId === s.projectId
        )
          events.push(event);
      });
      try {
        const result = await run(
          s,
          `${edits}; rm /tmp/work/kept; chmod 700 /tmp/new; for i in {1..100}; do touch /knowledge/file$i; done`,
        );
        expect(result.content).toContain("change receipts exceed");
        s.unchanged();
        expect(events).toEqual([]);
      } finally {
        off();
        s.db.close();
      }
    },
  );

  test("a fresh read-only command creates a scratch row and checks its revision", async () => {
    const s = setup();
    try {
      expect(await run(s, "true")).toEqual({ content: "exit 0", error: false });
      expect(scratchState(s)).toEqual({
        cwd: "/knowledge",
        revision: 1,
        bytes: 0,
        files: 0,
        entries: [],
        usedAt: 100,
      });
    } finally {
      s.db.close();
    }
  });

  test("scratch-only writes ignore lowered knowledge totals and unrelated racing edits", async () => {
    const s = prepared();
    const read = s.area.store.read.bind(s.area.store);
    s.area.store.read = (id) => {
      const rows = read(id);
      s.area.store.replace(s.file, s.author, "other writer", 150);
      return rows;
    };
    try {
      s.caps.knowledgeFiles = 0;
      s.caps.knowledgeProjectBytes = 1;
      s.caps.knowledgeFileBytes = 1;
      expect(await run(s, "cat /knowledge/existing > /tmp/copied")).toEqual({
        content: "exit 0",
        error: false,
      });
      expect(
        scratchState(s).entries.find((file) => file.path === "copied")?.data,
      ).toEqual(new TextEncoder().encode("original"));
      expect(s.area.read(s.projectId, s.file.id).text).toBe("other writer");
    } finally {
      s.db.close();
    }
  });
});

describe("scratch caps", () => {
  test.each([
    ["bytes", { scratchBytes: 7 }, "8 bytes, the limit is 7"],
    ["files", { scratchFiles: 1 }, "2 files, the limit is 1"],
  ])(
    "%s refusal includes the numbers and rolls back everything",
    async (_label, caps, words) => {
      const s = prepared();
      try {
        Object.assign(s.caps, caps);
        expect((await run(s, edits)).content).toContain(words);
        s.unchanged();
      } finally {
        s.db.close();
      }
    },
  );

  test("current scratch caps are read again at commit", async () => {
    const s = prepared();
    const read = s.area.scratch.read.bind(s.area.scratch);
    s.area.scratch.read = (id) => {
      s.caps.scratchFiles = 1;
      return read(id);
    };
    try {
      expect((await run(s, edits)).content).toContain(
        "2 files, the limit is 1",
      );
      s.unchanged();
    } finally {
      s.db.close();
    }
  });

  test("an oversized scratch mounts and shrinks under lowered byte and file caps", async () => {
    const s = setup({
      knowledgeProjectBytes: 1,
      scratchBytes: 1,
      scratchFiles: 1,
    });
    try {
      seedScratch(s, {
        written: [
          { path: "large", data: new Uint8Array(4 * 1024 * 1024), mode: 0o600 },
          { path: "other", data: new Uint8Array(10), mode: 0o600 },
        ],
      });
      expect((await run(s, "printf 123 > /tmp/large")).error).toBe(false);
      expect(scratchState(s)).toMatchObject({ files: 2, bytes: 13 });
      const before = scratchState(s);
      expect((await run(s, "printf 456 > /tmp/large")).content).toContain(
        "2 files, the limit is 1",
      );
      expect(scratchState(s)).toEqual(before);
      expect((await run(s, "rm /tmp/other")).error).toBe(false);
      expect(scratchState(s)).toMatchObject({ files: 1, bytes: 3 });
      expect((await run(s, "rm /tmp/large")).error).toBe(false);
      expect(scratchState(s)).toMatchObject({ files: 0, bytes: 0 });
    } finally {
      s.db.close();
    }
  });

  test.each([
    [
      "bytes",
      { scratchBytes: 1, scratchFiles: 10 },
      "rm /tmp/b; printf growing > /tmp/a",
      "bytes, the limit is 1",
    ],
    [
      "files",
      { scratchBytes: 100, scratchFiles: 1 },
      "printf x > /tmp/a; touch /tmp/c",
      "3 files, the limit is 1",
    ],
  ])(
    "a shrink cannot grow the over-cap %s dimension",
    async (_label, caps, command, words) => {
      const s = setup();
      try {
        seedScratch(s, {
          written: ["a", "b"].map((path) => ({
            path,
            data: new Uint8Array(2),
            mode: 0o600,
          })),
        });
        Object.assign(s.caps, caps);
        const before = scratchState(s);
        expect((await run(s, command)).content).toContain(words);
        expect(scratchState(s)).toEqual(before);
      } finally {
        s.db.close();
      }
    },
  );
});
