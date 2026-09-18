// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  judgeMembers,
  parseFolder,
  selectMembers,
} from "../../../src/server/knowledge/archive.ts";
import { commitKnowledge } from "../../../src/server/knowledge/commit.ts";
import type { ArchiveMember } from "../../../src/server/lib/archive.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { BadRequest } from "../../../src/server/lib/errors.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import type {
  KnowledgeUploadReason,
  KnowledgeUploadResult,
} from "../../../src/shared/contracts/knowledge.ts";
import { type Setup, setup } from "./helpers.ts";

type Entry = Omit<ArchiveMember, "index">;
const entry = (
  name: string,
  text: string | Uint8Array = "text",
  type: ArchiveMember["type"] = "file",
): Entry => {
  const data = typeof text === "string" ? new TextEncoder().encode(text) : text;
  return { name, type, data, size: data.length };
};
const manifest = (entries: Entry[]) =>
  entries.map((file, index) => ({ ...file, index }));

function judge(entries: Entry[], s?: Setup, folder = "") {
  const members = manifest(entries);
  return judgeMembers(
    members,
    selectMembers(members, folder),
    s?.area.store.read(s.projectId) ?? [],
    s?.caps ?? { ...DEFAULT_LIMITS, knowledgeFileBytes: 6 },
  );
}

function permutations<T>(items: T[]): T[][] {
  if (items.length === 0) return [[]];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, i) => i !== index)).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

function outcome(entries: Entry[], result: KnowledgeUploadResult) {
  return {
    ...result,
    saved: [...result.saved].sort(),
    skipped: result.skipped
      .map(({ index, other, reason }) => ({
        name: entries[index]!.name,
        other: other === undefined ? null : entries[other]!.name,
        reason,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const reasons: { reason: KnowledgeUploadReason; entries: Entry[] }[] = [
  { reason: "not-regular", entries: [entry("link", "", "symlink")] },
  { reason: "macos", entries: [entry("./__MACOSX/x")] },
  { reason: "outside", entries: [entry("docs/../x")] },
  { reason: "no-letters", entries: [entry("\u65e5\u672c\u8a9e")] },
  { reason: "too-long", entries: [entry("x".repeat(81))] },
  { reason: "bad-name", entries: [entry(".-.")] },
  {
    reason: "duplicate",
    entries: [entry("A b.md"), entry("a-b.md")],
  },
  { reason: "too-big", entries: [entry("large", "1234567")] },
  { reason: "not-text", entries: [entry("binary", new Uint8Array([255]))] },
  { reason: "clash", entries: [entry("docs"), entry("docs/child")] },
  { reason: "clash-live", entries: [entry("live/child")] },
];

test.each(reasons)(
  "$reason alone and mixed in every order keeps the same outcome",
  ({ reason, entries }) => {
    const s = setup({ knowledgeFileBytes: 6 });
    try {
      s.area.create(s.projectId, s.author, "live", "text");
      const alone = judge(entries, s);
      expect(alone.changes).toEqual([]);
      expect(alone.result.skipped.map((skip) => skip.reason)).toEqual(
        entries.map(() => reason),
      );
      for (const skip of alone.result.skipped) {
        if (reason === "duplicate" || reason === "clash") {
          expect(skip.other).toBe(1 - skip.index);
        } else {
          expect(skip).not.toHaveProperty("other");
        }
      }
      const mixed = [...entries, entry("a", "\0"), entry("a/b.md")];
      const expected = outcome(mixed, judge(mixed, s).result);
      expect(expected.saved).toEqual(["a/b.md"]);
      for (const order of permutations(mixed)) {
        expect(outcome(order, judge(order, s).result)).toEqual(expected);
      }
    } finally {
      s.db.close();
    }
  },
);

test("directories vanish, every non-regular type skips, raw metadata precedes normalization", () => {
  const files = [
    entry("ignored/", "", "directory"),
    entry("__MACOSX/symlink", "", "symlink"),
    entry("hardlink", "", "link"),
    entry("device", "", "other"),
    entry("./__MACOSX/x"),
    entry("a\\._b"),
    entry("a/.DS_Store"),
    entry("a/./__MACOSX//x"),
    entry("__macosx", ""),
  ];
  const { result } = judge(files);
  expect(result.skipped.map(({ index, reason }) => [index, reason])).toEqual([
    [1, "not-regular"],
    [2, "not-regular"],
    [3, "not-regular"],
    [4, "macos"],
    [5, "macos"],
    [6, "macos"],
    [7, "macos"],
  ]);
  expect(result.saved).toEqual(["__macosx"]);
});

test("the manifest reads neither normalized duplicates nor rejected names", () => {
  const members = manifest([
    entry("A b.md"),
    entry("a-b.md"),
    entry("A-B.MD"),
    entry("../outside"),
    entry("a", "\0"),
    entry("a/b.md"),
  ]);
  const selection = selectMembers(members, "");
  expect(selection.candidates.map((file) => file.index)).toEqual([4, 5]);
  expect(
    selection.skipped
      .filter((skip) => skip.reason === "duplicate")
      .map(({ index, other }) => [index, other]),
  ).toEqual([
    [0, 1],
    [1, 0],
    [2, 0],
  ]);
});

test("all eligible prefix clashes lose regardless of their order", () => {
  const files = [entry("a"), entry("a/b"), entry("a/b/c")];
  for (const order of permutations(files)) {
    const { result } = judge(order);
    expect(result.saved).toEqual([]);
    expect(result.skipped.map((skip) => skip.reason)).toEqual([
      "clash",
      "clash",
      "clash",
    ]);
    for (const skip of result.skipped) {
      expect(skip.other).toBe(skip.index === 0 ? 1 : 0);
    }
  }
});

test("both directions of a live prefix clash skip, exact names replace", () => {
  const s = setup();
  try {
    s.area.create(s.projectId, s.author, "docs/a.md", "old");
    s.area.create(s.projectId, s.author, "leaf", "old");
    const { result } = judge(
      [entry("docs"), entry("leaf/b"), entry("docs/a.md", "new")],
      s,
    );
    // The eligible docs entry also conflicts with the replacement.
    expect(result.skipped.map((skip) => skip.reason)).toEqual([
      "clash",
      "clash-live",
      "clash",
    ]);
    expect(judge([entry("docs")], s).result.skipped[0]?.reason).toBe(
      "clash-live",
    );
    expect(judge([entry("docs/a.md", "new")], s).result.replaced).toBe(1);
  } finally {
    s.db.close();
  }
});

test.each([
  "folder=..",
  "folder=a/../b",
  "folder=.-.",
  "folder=a/b/c/d/e/f/g/h",
  `folder=${"a".repeat(60)}/${"b".repeat(60)}/${"c".repeat(59)}`,
  "folder=first&folder=second",
  "folder=&folder=",
])("refuses %s with a field-named 400", (query) => {
  expect(() => parseFolder(new URLSearchParams(query))).toThrow(BadRequest);
  expect(() => parseFolder(new URLSearchParams(query))).toThrow("folder");
});

test("folder normalizes, accepts root and its exact boundaries, and counts in final names", () => {
  for (const raw of ["", "/", "./", "\\"]) {
    expect(parseFolder(new URLSearchParams({ folder: raw }))).toBe("");
  }
  expect(parseFolder(new URLSearchParams({ folder: "My Docs/On Call" }))).toBe(
    "my-docs/on-call",
  );
  const folder = `${"a".repeat(60)}/${"b".repeat(60)}/${"c".repeat(58)}`;
  expect(parseFolder(new URLSearchParams({ folder }))).toBe(folder);
  expect(parseFolder(new URLSearchParams({ folder: "a/b/c/d/e/f/g" }))).toBe(
    "a/b/c/d/e/f/g",
  );
  expect(
    judge([entry("x".repeat(20))], undefined, folder).result.skipped,
  ).toMatchObject([{ reason: "too-long" }]);
  expect(
    judge([entry("h/i")], undefined, "a/b/c/d/e/f/g").result.skipped,
  ).toMatchObject([{ reason: "too-long" }]);
  expect(judge([entry("h")], undefined, "a/b/c/d/e/f/g").result.saved).toEqual([
    "a/b/c/d/e/f/g/h",
  ]);
});

function request(body: BodyInit, query = "") {
  return new Request(`http://knowledge.test/upload?${query}`, {
    method: "POST",
    body,
  });
}

function upload(s: Setup, body: BodyInit, query = "") {
  return s.area.upload(s.projectId, s.author, request(body, query));
}

async function tar(files: Record<string, string | Uint8Array>) {
  return new Bun.Archive(files).bytes();
}

test("loose files use their normalized name, and archives ignore name", async () => {
  const s = setup();
  try {
    expect(
      await upload(s, "hello", "name=Q3+Plan+(Final).md&folder=My+Docs"),
    ).toEqual({
      added: 1,
      replaced: 0,
      unchanged: 0,
      renamed: 1,
      saved: ["my-docs/q3-plan-final.md"],
      skipped: [],
      skippedTotal: 0,
    });
    const plain = await upload(s, "plain", "folder=Another+Folder&name=plain");
    expect(plain.renamed).toBe(0);
    expect(plain.saved).toEqual(["another-folder/plain"]);
    // how the archive spells a path is not a rename
    const spelled = await upload(
      s,
      await tar({ "./docs//spelled.md": "text" }),
    );
    expect(spelled.renamed).toBe(0);
    expect(spelled.saved).toEqual(["docs/spelled.md"]);
    expect(
      await upload(
        s,
        await tar({ "archive.md": "text" }),
        "name=&name=ignored",
      ),
    ).toMatchObject({ added: 1, saved: ["archive.md"] });
    for (const query of ["", "name=", "name=a&name=b"]) {
      await expect(upload(s, "text", query)).rejects.toMatchObject({
        status: 400,
        message: "name is required once for a text file",
      });
    }
    expect(
      await upload(s, new Uint8Array([0, 255]), "name=image.png"),
    ).toMatchObject({
      added: 0,
      skipped: [{ index: 0, name: "image.png", reason: "not-text" }],
      skippedTotal: 1,
    });
  } finally {
    s.db.close();
  }
});

test.each(["types.tar", "types.tar.gz", "stored.zip", "deflated.zip"])(
  "%s goes through the shared reader and ordered manifest passes",
  async (name) => {
    const s = setup();
    try {
      const bytes = await Bun.file(
        new URL(`../../fixtures/archives/${name}`, import.meta.url),
      ).bytes();
      const result = await upload(s, bytes);
      expect(result.added).toBeGreaterThan(0);
      expect(result.skipped.some((skip) => skip.reason === "not-regular")).toBe(
        true,
      );
      expect(s.area.list(s.projectId).files.map((file) => file.name)).toContain(
        "empty.md",
      );
    } finally {
      s.db.close();
    }
  },
);

test("a recognized broken archive is refused rather than saved as text", async () => {
  const s = setup();
  try {
    await expect(
      upload(s, "PK\u0003\u0004broken", "name=text"),
    ).rejects.toMatchObject({ status: 400 });
    expect(s.area.list(s.projectId).files).toEqual([]);
    expect(await upload(s, "text", "name=next")).toMatchObject({ added: 1 });
  } finally {
    s.db.close();
  }
});

test.serial(
  "writes one post-image and event per file, replacing with user-authored History",
  async () => {
    const s = setup();
    const file = s.area.create(s.projectId, s.agent, "existing.md", "old");
    const events: BusEvent[] = [];
    const visibleCounts: number[] = [];
    const off = subscribe((event) => {
      if (
        event.type === "knowledge.changed" &&
        event.data.projectId === s.projectId
      ) {
        events.push(event);
        visibleCounts.push(s.area.list(s.projectId).files.length);
      }
    });
    try {
      s.now.value++;
      expect(
        await upload(
          s,
          await tar({ "Existing.md": "new", "Added.md": "added" }),
        ),
      ).toMatchObject({ added: 1, replaced: 1, renamed: 2, unchanged: 0 });
      const current = s.area.read(s.projectId, file.id);
      expect(current).toMatchObject({
        text: "new",
        revision: 2,
        author: s.author,
      });
      const versions = s.area.versions(s.projectId, file.id);
      expect(versions.map((version) => version.revision)).toEqual([2, 1]);
      expect(s.area.version(s.projectId, versions[1]!.id).text).toBe("old");
      expect(versions[0]?.author).toEqual(s.author);
      expect(events).toHaveLength(2);
      expect(visibleCounts).toEqual([2, 2]);
      for (const event of events) {
        expect(event).toMatchObject({
          type: "knowledge.changed",
          data: { deleted: false, file: { author: s.author } },
        });
      }
      const added = s.area.store.byName(s.projectId, "added.md")!;
      expect(s.area.versions(s.projectId, added.id)).toHaveLength(1);
    } finally {
      off();
      s.db.close();
    }
  },
);

test("a smaller replacement survives a lowered file cap", async () => {
  const s = setup({ knowledgeFileBytes: 10 });
  try {
    const file = s.area.create(s.projectId, s.author, "large", "1234567890");
    s.caps.knowledgeFileBytes = 3;
    expect(await upload(s, "12345", "name=large")).toMatchObject({
      replaced: 1,
      skipped: [],
    });
    expect(s.area.read(s.projectId, file.id)).toMatchObject({
      text: "12345",
      revision: 2,
    });
    expect(await upload(s, "abcde", "name=large")).toMatchObject({
      replaced: 0,
      skipped: [{ reason: "too-big" }],
    });
  } finally {
    s.db.close();
  }
});

test.serial(
  "all unchanged or skipped checks no totals, writes no rows and evicts nothing on an over-cap base",
  async () => {
    const s = setup();
    const file = s.area.create(s.projectId, s.author, "same", "first");
    s.area.replace(s.projectId, s.author, file.id, "same", 1);
    s.area.create(s.projectId, s.author, "another", "text");
    s.caps.knowledgeFiles = 1;
    s.caps.knowledgeProjectBytes = 1;
    s.caps.knowledgeVersions = 1;
    s.caps.knowledgeHistoryBytes = 1;
    const before = s.area.store.read(s.projectId);
    const versions = s.area.versions(s.projectId, file.id);
    const events: BusEvent[] = [];
    const off = subscribe((event) => events.push(event));
    const changes = () =>
      s.db.query<{ n: number }, []>("select total_changes() as n").get()!.n;
    const previous = changes();
    s.area.store.totals = () => {
      throw new Error("no totals on a no-op");
    };
    s.area.store.evict = () => {
      throw new Error("no eviction on a no-op");
    };
    try {
      const result = await upload(
        s,
        await tar({ Same: "same", binary: new Uint8Array([0]) }),
      );
      expect(result).toMatchObject({
        added: 0,
        replaced: 0,
        unchanged: 1,
        renamed: 0,
        saved: [],
        skippedTotal: 1,
      });
      expect(changes()).toBe(previous);
      expect(s.area.store.read(s.projectId)).toEqual(before);
      expect(s.area.versions(s.projectId, file.id)).toEqual(versions);
      expect(events).toEqual([]);
      expect(
        commitKnowledge(s.area.store, s.projectId, s.author, [], s.caps, 100),
      ).toEqual({ receipts: [], events: [] });
    } finally {
      off();
      s.db.close();
    }
  },
);

test.each([
  {
    caps: { knowledgeFiles: 1 },
    message: "the base would have 2 files, the limit is 1",
  },
  {
    caps: { knowledgeProjectBytes: 5 },
    message: "the base would be 6 bytes, the limit is 5",
  },
])(
  "totals refuse the entire upload with numbers: $message",
  async ({ caps, message }) => {
    const s = setup(caps);
    try {
      const file = s.area.create(s.projectId, s.author, "one", "old");
      await expect(
        upload(s, await tar({ one: "new", two: "two" })),
      ).rejects.toMatchObject({ status: 400, message });
      expect(s.area.store.read(s.projectId).map((row) => row.text)).toEqual([
        "old",
      ]);
      expect(s.area.versions(s.projectId, file.id)).toHaveLength(1);
    } finally {
      s.db.close();
    }
  },
);

test.each(["replace", "recreate", "delete", "create"] as const)(
  "a live identity moving before the transaction refuses all changes: %s",
  async (action) => {
    const s = setup();
    const file =
      action === "create"
        ? null
        : s.area.create(s.projectId, s.author, "racing", "old");
    const read = s.area.store.read.bind(s.area.store);
    s.area.store.read = (id) => {
      const rows = read(id);
      if (action === "replace")
        s.area.replace(id, s.author, file!.id, "other", 1);
      if (action === "delete" || action === "recreate")
        s.area.remove(id, s.author, file!.id);
      if (action === "create" || action === "recreate")
        s.area.create(id, s.author, "racing", "other");
      return rows;
    };
    try {
      await expect(
        upload(s, await tar({ added: "new", racing: "new" })),
      ).rejects.toMatchObject({
        status: 409,
        message: "racing changed while uploading, try again",
      });
      expect(s.area.store.byName(s.projectId, "added")).toBeNull();
      expect(s.area.store.byName(s.projectId, "racing")?.text ?? null).toBe(
        action === "delete" ? null : "other",
      );
    } finally {
      s.db.close();
    }
  },
);

test("eviction still applies to replacements and restores stay available when budget permits", async () => {
  const s = setup();
  try {
    const file = s.area.create(s.projectId, s.author, "file", "old");
    await upload(s, "new", "name=file");
    const old = s.area.versions(s.projectId, file.id)[1]!;
    const restored = s.area.replace(
      s.projectId,
      s.author,
      file.id,
      s.area.version(s.projectId, old.id).text,
      2,
    );
    expect(restored.revision).toBe(3);
    s.caps.knowledgeVersions = 2;
    s.caps.knowledgeHistoryBytes = 4;
    await upload(s, "next", "name=file");
    expect(
      s.area.versions(s.projectId, file.id).map((v) => v.revision),
    ).toEqual([4]);
    expect(s.area.read(s.projectId, file.id).text).toBe("next");
  } finally {
    s.db.close();
  }
});

test("normalization never replaces a differently cased bash name", async () => {
  const s = setup();
  try {
    const file = s.area.create(s.projectId, s.agent, "README.md", "agent");
    expect(await upload(s, "user", "name=README.md")).toMatchObject({
      added: 1,
      replaced: 0,
      renamed: 1,
      saved: ["readme.md"],
    });
    expect(s.area.read(s.projectId, file.id).text).toBe("agent");
  } finally {
    s.db.close();
  }
});

test("the answer cuts both lists, counts every skip and stays under 128 KiB on a worst archive", async () => {
  const s = setup();
  try {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1800; i++) {
      files[`D${" ".repeat(200)}${"!".repeat(i + 1)}ocs.md`] = "skip";
    }
    for (let i = 0; i < 200; i++) files[`saved/${i}.md`] = "save";
    const result = await upload(s, await tar(files));
    expect(result).toMatchObject({ added: 200, skippedTotal: 1800 });
    expect(result.saved).toHaveLength(200);
    expect(result.skipped).toHaveLength(200);
    expect(
      result.skipped.every(
        (skip) =>
          skip.name.length === 200 &&
          skip.reason === "duplicate" &&
          skip.other !== undefined,
      ),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(128 * 1024);
    const saved = judge(
      Array.from({ length: 201 }, (_, i) => entry(`file${i}`)),
    );
    expect(saved.result.saved).toHaveLength(200);
    expect(saved.result.added).toBe(201);
  } finally {
    s.db.close();
  }
});

test.each(["\u0001", "\u200b", "\ud800"])(
  "escaping and UTF-8 expansion cannot grow the bounded answer: %j",
  (character) => {
    const skipped = Array.from({ length: 1800 }, (_, i) =>
      entry(`${character.repeat(200)}${"!".repeat(i + 1)}a.md`),
    );
    const saved = Array.from({ length: 200 }, (_, i) =>
      entry(`${"a".repeat(80)}/${"b".repeat(80)}/${`${i}`.padStart(38, "c")}`),
    );
    const { result } = judge([...skipped, ...saved]);
    expect(result.added).toBe(200);
    expect(result.skippedTotal).toBe(1800);
    expect(result.skipped).toHaveLength(200);
    expect(
      result.skipped.every(
        (skip) => skip.reason === "duplicate" && skip.name.length <= 200,
      ),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(128 * 1024);
  },
);
