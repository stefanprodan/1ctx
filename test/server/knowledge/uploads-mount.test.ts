// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import {
  callCaps,
  freshSignal,
  run,
  type Setup,
  scratchState,
  seedScratch,
  setup,
} from "./helpers.ts";

const discarded =
  "changes under /uploads were discarded: copy a file to /tmp to change it";
const megabyte = 1024 * 1024;
const files = { "docs/readme.md": "first\nneedle café\n", "empty.txt": "" };

function seedUploads(
  s: Setup,
  entries: Record<string, string>,
  sessionId = s.session.id,
) {
  transact(s.db, () => {
    const rows = Object.entries(entries);
    const before = s.area.uploads.read(sessionId);
    s.db
      .query("delete from session_uploads where session_id = ?")
      .run(sessionId);
    s.db
      .query(
        `insert into session_uploads (session_id, revision, bytes, files)
         values (?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        before.revision + 1,
        rows.reduce((total, [, text]) => total + Buffer.byteLength(text), 0),
        rows.length,
      );
    const insert = s.db.query(
      `insert into session_upload_files
       (session_id, name, text, bytes, message_id, item, archive, folder, created_at)
       values (?, ?, ?, ?, ?, ?, ?, '', ?)`,
    );
    for (const [name, text] of rows)
      insert.run(
        sessionId,
        name,
        text,
        Buffer.byteLength(text),
        "attached-message",
        "docs.zip",
        1,
        s.now.value,
      );
    return { result: undefined };
  });
}

describe("uploaded files in command mounts", () => {
  test("an empty uploads directory exists without creating stored rows", async () => {
    const s = setup();
    try {
      const before = s.area.uploads.read(s.session.id);
      expect(await run(s, "test -d /uploads; ls /uploads")).toEqual({
        content: "exit 0",
        error: false,
        opened: [],
        tail: 6,
      });
      expect(s.area.uploads.read(s.session.id)).toEqual(before);
      expect(before).toEqual({ revision: 0, bytes: 0, files: 0, entries: [] });
    } finally {
      s.db.close();
    }
  });

  test("cat and recursive grep read uploaded text without changing its rows", async () => {
    const s = setup();
    try {
      seedUploads(s, files);
      const before = s.area.uploads.read(s.session.id);
      const result = await run(
        s,
        "cat /uploads/docs/readme.md; grep -rn needle /uploads",
      );
      expect(result.error).toBe(false);
      expect(result.content).toStartWith(files["docs/readme.md"]);
      expect(result.content).toContain("/uploads/docs/readme.md:2:needle café");
      expect(result.content).not.toContain(discarded);
      expect(s.area.uploads.read(s.session.id)).toEqual(before);
    } finally {
      s.db.close();
    }
  });

  test("a copy into scratch survives a fresh mount", async () => {
    const s = setup();
    try {
      seedUploads(s, files);
      expect(await run(s, "cp /uploads/docs/readme.md /tmp/copy")).toEqual({
        content: "exit 0",
        error: false,
        opened: [],
        tail: 6,
      });
      expect(Buffer.from(scratchState(s).entries[0]!.data).toString()).toBe(
        files["docs/readme.md"],
      );
      expect((await run(s, "cat /tmp/copy")).content).toStartWith(
        files["docs/readme.md"],
      );
      expect(s.area.list(s.projectId).files).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test.each([
    ["write", "printf changed | tee /uploads/docs/readme.md"],
    ["append", "printf changed >> /uploads/docs/readme.md"],
    ["delete", "rm /uploads/docs/readme.md"],
    ["edit", "sed -i 's/first/changed/' /uploads/docs/readme.md"],
    ["truncate", "> /uploads/docs/readme.md"],
    ["redirect", "printf changed > /uploads/docs/readme.md"],
    ["move", "mv /uploads/docs/readme.md /tmp/moved"],
    ["add", "printf added > /uploads/new.txt"],
    ["empty directory", "mkdir /uploads/empty"],
    [
      "file becomes directory",
      "rm /uploads/empty.txt; mkdir /uploads/empty.txt",
    ],
    [
      "directory becomes file",
      "rm -r /uploads/docs; printf text > /uploads/docs",
    ],
    [
      "file symlink",
      "rm /uploads/empty.txt; ln -s /knowledge/kept /uploads/empty.txt",
    ],
    [
      "directory symlink",
      "rm -r /uploads/docs; ln -s /knowledge /uploads/docs",
    ],
    ["added symlink", "ln -s /tmp /uploads/link"],
    ["symlink loop", "ln -s /uploads/loop /uploads/loop"],
  ])(
    "an upload %s is discarded while knowledge and scratch commit",
    async (_name, command) => {
      const s = setup();
      try {
        seedUploads(s, files);
        const before = s.area.uploads.read(s.session.id);
        const result = await run(
          s,
          `printf shared > /knowledge/kept; printf scratch > /tmp/kept; ${command}`,
        );
        expect(result.error).toBe(false);
        expect(result.content).toStartWith(`${discarded}\n`);
        expect(result.content).toContain("wrote kept (rev 1, 1 lines)");
        expect(s.area.store.byName(s.projectId, "kept")?.text).toBe("shared");
        const kept = scratchState(s).entries.find(
          (file) => file.path === "kept",
        );
        expect(Buffer.from(kept!.data).toString()).toBe("scratch");
        if (_name === "move") {
          const moved = scratchState(s).entries.find(
            (file) => file.path === "moved",
          );
          expect(Buffer.from(moved!.data).toString()).toBe(
            files["docs/readme.md"],
          );
        }
        expect(s.area.uploads.read(s.session.id)).toEqual(before);
        const next = await run(s, "cat /uploads/docs/readme.md");
        expect(next.error).toBe(false);
        expect(next.content).toStartWith(files["docs/readme.md"]);
      } finally {
        s.db.close();
      }
    },
  );

  for (const populated of [false, true]) {
    test.each([
      ["removed", "rm -rf /uploads"],
      ["replaced with a file", "rm -rf /uploads; printf text > /uploads"],
      ["replaced with a symlink", "rm -rf /uploads; ln -s /knowledge /uploads"],
    ])(
      `the ${populated ? "populated" : "empty"} uploads root is %s`,
      async (_name, command) => {
        const s = setup();
        try {
          if (populated) seedUploads(s, files);
          const before = s.area.uploads.read(s.session.id);
          const result = await run(
            s,
            `printf shared > /knowledge/kept; printf scratch > /tmp/kept; ${command}`,
          );
          expect(result.error).toBe(false);
          expect(result.content).toStartWith(`${discarded}\n`);
          expect(s.area.store.byName(s.projectId, "kept")?.text).toBe("shared");
          expect(scratchState(s).files).toBe(1);
          expect(s.area.uploads.read(s.session.id)).toEqual(before);
          expect((await run(s, "test -d /uploads")).error).toBe(false);
        } finally {
          s.db.close();
        }
      },
    );
  }

  test("mode and timestamp changes are silently discarded", async () => {
    const s = setup();
    try {
      seedUploads(s, files);
      const before = s.area.uploads.read(s.session.id);
      const mode = await run(s, "stat -c %a /uploads/docs/readme.md");
      const result = await run(
        s,
        "chmod 700 /uploads /uploads/docs; chmod 600 /uploads/docs/readme.md; touch /uploads /uploads/docs /uploads/docs/readme.md",
      );
      expect(result).toEqual({
        content: "exit 0",
        error: false,
        opened: [],
        tail: 6,
      });
      expect(await run(s, "stat -c %a /uploads/docs/readme.md")).toEqual(mode);
      expect(s.area.uploads.read(s.session.id)).toEqual(before);
    } finally {
      s.db.close();
    }
  });

  test("identical writes and temporary additions leave no notice", async () => {
    const s = setup();
    try {
      seedUploads(s, files);
      expect(
        await run(
          s,
          "cp /uploads/docs/readme.md /tmp/copy; cat /tmp/copy > /uploads/docs/readme.md; mkdir /uploads/empty; rmdir /uploads/empty",
        ),
      ).toEqual({ content: "exit 0", error: false, opened: [], tail: 6 });
    } finally {
      s.db.close();
    }
  });

  test("ordinary nonzero exits keep other trees and discard upload edits", async () => {
    const s = setup();
    try {
      seedUploads(s, files);
      const before = s.area.uploads.read(s.session.id);
      const result = await run(
        s,
        "printf shared > /knowledge/kept; printf scratch > /tmp/kept; rm -r /uploads; false",
      );
      expect(result.error).toBe(true);
      expect(result.content).toStartWith(`${discarded}\n`);
      expect(result.content).toContain("exit 1");
      expect(s.area.store.byName(s.projectId, "kept")?.text).toBe("shared");
      expect(scratchState(s).files).toBe(1);
      expect(s.area.uploads.read(s.session.id)).toEqual(before);
    } finally {
      s.db.close();
    }
  });
});

describe("uploaded working directories", () => {
  test.each(["/uploads", "/uploads/docs"])(
    "%s is kept for the next command",
    async (cwd) => {
      const s = setup();
      try {
        seedUploads(s, files);
        expect((await run(s, `cd ${cwd}`)).error).toBe(false);
        expect(scratchState(s).cwd).toBe(cwd);
        const result = await run(s, "pwd");
        expect(result.content).toBe(`${cwd}\n\nexit 0`);
        expect(scratchState(s).cwd).toBe(cwd);
      } finally {
        s.db.close();
      }
    },
  );

  test.each(["missing", "file"])(
    "a saved uploads directory that is now %s falls back",
    async (kind) => {
      const s = setup();
      try {
        seedUploads(s, files);
        expect((await run(s, "cd /uploads/docs")).error).toBe(false);
        seedUploads(s, kind === "file" ? { docs: "not a directory" } : {});
        const result = await run(s, "pwd");
        expect(result.content).toStartWith(
          "started in /knowledge: /uploads/docs no longer exists\n/knowledge\n",
        );
        expect(result.content).not.toContain(discarded);
        expect(scratchState(s).cwd).toBe("/knowledge");
      } finally {
        s.db.close();
      }
    },
  );

  test("the discard notice precedes a missing-cwd notice", async () => {
    const s = setup();
    try {
      expect((await run(s, "mkdir /uploads/new; cd /uploads/new")).error).toBe(
        false,
      );
      expect(scratchState(s).cwd).toBe("/uploads/new");
      const result = await run(s, "mkdir /uploads/new; pwd");
      expect(result.error).toBe(false);
      expect(result.content).toStartWith(
        `${discarded}\nstarted in /knowledge: /uploads/new no longer exists\n/knowledge\n`,
      );
      expect(result.content.length).toBeLessThanOrEqual(callCaps.resultCut);
      expect(scratchState(s).cwd).toBe("/knowledge");
    } finally {
      s.db.close();
    }
  });
});

describe("upload mount budgets and isolation", () => {
  test("a file over a lowered I/O cap can still shrink an oversized scratch", async () => {
    const s = setup({ knowledgeFileBytes: 2 * megabyte });
    const text = "x".repeat(2 * megabyte);
    try {
      seedUploads(s, { payload: text });
      seedScratch(s, {
        written: [
          {
            path: "copy",
            data: new Uint8Array(2 * megabyte).fill(121),
            mode: 0o644,
          },
          { path: "remove", data: new Uint8Array([1]), mode: 0o644 },
        ],
      });
      s.caps.knowledgeFileBytes = megabyte;
      s.caps.scratchBytes = megabyte;
      const before = s.area.uploads.read(s.session.id);
      expect(
        await run(s, "cat /uploads/payload > /tmp/copy; rm /tmp/remove"),
      ).toEqual({
        content: "exit 0",
        error: false,
        opened: [],
        tail: 6,
      });
      expect(Buffer.from(scratchState(s).entries[0]!.data).toString()).toBe(
        text,
      );
      expect(s.area.uploads.read(s.session.id)).toEqual(before);
    } finally {
      s.db.close();
    }
  });

  test("an existing tree over the current byte and file caps still mounts", async () => {
    const s = setup({
      knowledgeProjectBytes: megabyte,
      scratchBytes: megabyte,
      uploadBytes: 8 * megabyte,
      knowledgeFileBytes: megabyte,
    });
    try {
      seedUploads(
        s,
        Object.fromEntries(
          Array.from({ length: 12 }, (_, index) => [
            `payload-${index}`,
            "x".repeat(megabyte / 2),
          ]),
        ),
      );
      s.caps.uploadBytes = megabyte;
      s.caps.uploadFiles = 10;
      const before = s.area.uploads.read(s.session.id);
      const result = await run(s, "cat /uploads/payload-11 | wc -c");
      expect(result.error).toBe(false);
      expect(result.content).toContain(String(megabyte / 2));
      expect(result.content).not.toContain(discarded);
      expect(s.area.uploads.read(s.session.id)).toEqual(before);
    } finally {
      s.db.close();
    }
  });

  test("traversal accounts for the uploaded directories and files", async () => {
    const s = setup();
    try {
      seedUploads(
        s,
        Object.fromEntries(
          Array.from({ length: 500 }, (_, index) => [
            `group-${index}/docs/readme.md`,
            "text",
          ]),
        ),
      );
      const result = await run(s, "find /uploads -type f | wc -l");
      expect(result.error).toBe(false);
      expect(result.content).toContain("500");
      expect(result.content).not.toContain(discarded);
    } finally {
      s.db.close();
    }
  });

  test("a megabyte passes through pipelines, redirects and substitutions", async () => {
    const s = setup({
      knowledgeFileBytes: megabyte,
      scratchBytes: 4 * megabyte,
    });
    const text = "x".repeat(megabyte);
    try {
      seedUploads(s, { payload: text });
      for (const command of [
        "cat /uploads/payload | base64 > /tmp/encoded",
        "cat /uploads/payload > /tmp/copy",
        'value=$(cat /uploads/payload); printf %s "$value" > /tmp/substituted',
      ]) {
        const result = await run(s, command, {
          ...callCaps,
          callTimeoutMs: 10_000,
        });
        expect(result).toEqual({
          content: "exit 0",
          error: false,
          opened: [],
          tail: 6,
        });
      }
      const stored = new Map(
        scratchState(s).entries.map((file) => [
          file.path,
          Buffer.from(file.data).toString(),
        ]),
      );
      expect(stored.get("copy")).toBe(text);
      expect(stored.get("substituted")).toBe(text);
      expect(Buffer.from(stored.get("encoded")!, "base64").toString()).toBe(
        text,
      );
    } finally {
      s.db.close();
    }
  });

  test("another session has an independent uploads tree", async () => {
    const s = setup();
    try {
      seedUploads(s, files);
      const other = s.makeSession();
      expect(
        await run(s, "ls /uploads", callCaps, freshSignal(), other.id),
      ).toEqual({ content: "exit 0", error: false, opened: [], tail: 6 });
      seedUploads(s, { other: "separate" }, other.id);
      const result = await run(
        s,
        "ls /uploads; cat /uploads/other",
        callCaps,
        freshSignal(),
        other.id,
      );
      expect(result.error).toBe(false);
      expect(result.content).toStartWith("other\nseparate");
      expect((await run(s, "ls /uploads")).content).toStartWith(
        "docs\nempty.txt\n",
      );
    } finally {
      s.db.close();
    }
  });

  test("an upload revision moving after the snapshot does not conflict", async () => {
    const s = setup();
    try {
      seedUploads(s, files);
      const read = s.area.uploads.read.bind(s.area.uploads);
      const before = read(s.session.id);
      s.area.uploads.read = (sessionId) => {
        const snapshot = read(sessionId);
        transact(s.db, () => {
          s.db
            .query(
              "update session_uploads set revision = revision + 1 where session_id = ?",
            )
            .run(sessionId);
          return { result: undefined };
        });
        return snapshot;
      };
      const result = await run(
        s,
        "printf shared > /knowledge/kept; printf scratch > /tmp/kept; rm /uploads/empty.txt",
      );
      expect(result.error).toBe(false);
      expect(result.content).toStartWith(`${discarded}\n`);
      expect(read(s.session.id)).toEqual({
        ...before,
        revision: before.revision + 1,
      });
      expect(s.area.store.byName(s.projectId, "kept")?.text).toBe("shared");
      expect(scratchState(s).files).toBe(1);
    } finally {
      s.db.close();
    }
  });
});
