// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { skippedName } from "../../../src/server/knowledge/judge.ts";
import {
  MAX_ARCHIVE_UPLOAD,
  MAX_STAGED_ITEMS,
  UPLOAD_LEASE_MS,
} from "../../../src/server/knowledge/limits.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { MAX_UPLOADS_PER_MESSAGE } from "../../../src/shared/uploads.ts";
import { archiveFixture, setupUploads, staged } from "./uploads-helpers.ts";

test("a loose text file is staged at the root and the list keeps its full answer", async () => {
  const s = await setupUploads();
  try {
    const item = await staged(
      await s.upload({
        name: "Caf\u00e9 Runbook.md",
        attempt: "first-try",
        body: "\ufeffhello\n",
      }),
    );
    expect(item).toEqual({
      id: expect.any(String),
      attempt: "first-try",
      name: "Caf\u00e9 Runbook.md",
      archive: false,
      folder: "",
      files: 1,
      bytes: 6,
      saved: ["cafe-runbook.md"],
      skipped: [],
      skippedTotal: 0,
      renamed: 1,
      expiresAt: s.app.now.value + UPLOAD_LEASE_MS,
    });
    expect(await s.list()).toEqual({
      items: [item],
      limits: {
        itemBytes: MAX_ARCHIVE_UPLOAD,
        fileBytes: DEFAULT_LIMITS.knowledgeFileBytes,
        uploadBytes: DEFAULT_LIMITS.uploadBytes,
        uploadFiles: DEFAULT_LIMITS.uploadFiles,
        perMessage: MAX_UPLOADS_PER_MESSAGE,
        stagedItems: MAX_STAGED_ITEMS,
      },
    });
    expect(s.app.knowledge.list(s.projectId).files).toEqual([]);
    await s.limits({
      uploadBytes: 1024 * 1024,
      uploadFiles: 10,
      knowledgeFileBytes: 4096,
    });
    expect((await s.list()).limits).toMatchObject({
      uploadBytes: 1024 * 1024,
      uploadFiles: 10,
      fileBytes: 4096,
    });
    expect((await s.list()).items).toEqual([item]);
  } finally {
    await s.close();
  }
});

test.each([
  ["types.tar", "My Docs.tar", "my-docs"],
  ["types.tar.gz", "My Docs.tar.gz", "my-docs"],
  ["types.tar.gz", "My Docs.tgz", "my-docs"],
  ["stored.zip", "My Docs.zip", "my-docs"],
  ["deflated.zip", "\u65e5\u672c\u8a9e.zip", "archive"],
])(
  "%s expands under the picked archive's folder",
  async (fixture, name, folder) => {
    const s = await setupUploads();
    try {
      const item = await staged(
        await s.upload({ name, body: await archiveFixture(fixture) }),
      );
      expect(item.archive).toBe(true);
      expect(item.folder).toBe(folder);
      expect(item.files).toBeGreaterThan(0);
      expect(item.saved).toContain(`${folder}/empty.md`);
      expect(item.saved.every((path) => path.startsWith(`${folder}/`))).toBe(
        true,
      );
      expect(item.skipped.some((skip) => skip.reason === "not-regular")).toBe(
        true,
      );
      expect((await s.list()).items).toEqual([item]);
    } finally {
      await s.close();
    }
  },
);

const folderCases: {
  label: string;
  entries: Record<string, string>;
  folder: string;
  saved: string[];
}[] = [
  {
    label: "a single top-level folder",
    entries: { "runbooks/one.md": "one", "runbooks/nested/two.md": "two" },
    folder: "",
    saved: ["runbooks/one.md", "runbooks/nested/two.md"],
  },
  {
    label: "a root member beside a folder",
    entries: { "one.md": "one", "runbooks/two.md": "two" },
    folder: "runbooks",
    saved: ["runbooks/one.md", "runbooks/runbooks/two.md"],
  },
  {
    label: "two top-level folders",
    entries: { "ops/one.md": "one", "docs/two.md": "two" },
    folder: "runbooks",
    saved: ["runbooks/ops/one.md", "runbooks/docs/two.md"],
  },
  {
    label: "a root member rejected only when judging text",
    entries: { binary: "\0", "runbooks/two.md": "two" },
    folder: "runbooks",
    saved: ["runbooks/runbooks/two.md"],
  },
  {
    label: "a second top-level folder rejected only when judging text",
    entries: { "ops/binary": "\0", "runbooks/two.md": "two" },
    folder: "runbooks",
    saved: ["runbooks/runbooks/two.md"],
  },
];

test.each(folderCases)(
  "$label determines the folder on POST and GET",
  async (fixture) => {
    const s = await setupUploads();
    try {
      const item = await staged(
        await s.upload({
          name: "runbooks.tar",
          body: await new Bun.Archive(fixture.entries).bytes(),
        }),
      );
      expect(item).toMatchObject({
        archive: true,
        folder: fixture.folder,
        files: fixture.saved.length,
        saved: fixture.saved,
      });
      expect((await s.list()).items).toEqual([item]);
      expect(
        s.app.db
          .query(
            "select name from upload_staged_files where upload_id = ? order by position",
          )
          .all(item.id!),
      ).toEqual(fixture.saved.map((name) => ({ name })));
    } finally {
      await s.close();
    }
  },
);

test("a single-root archive keeps its empty folder when every candidate fails byte or text judging", async () => {
  const s = await setupUploads();
  try {
    await s.limits({ knowledgeFileBytes: 4096 });
    const item = await staged(
      await s.upload({
        name: "runbooks.tar",
        body: await new Bun.Archive({
          ".DS_Store": "metadata",
          "__MACOSX/._runbooks": "metadata",
          "runbooks/.git/HEAD": "ref",
          "runbooks/large.md": "x".repeat(4097),
          "runbooks/binary": new Uint8Array([0]),
        }).bytes(),
      }),
    );
    expect(item).toMatchObject({
      id: null,
      archive: true,
      folder: "",
      expiresAt: null,
      files: 0,
      bytes: 0,
      saved: [],
      skippedTotal: 2,
      skipped: [
        { name: "runbooks/large.md", reason: "too-big" },
        { name: "runbooks/binary", reason: "not-text" },
      ],
    });
    expect((await s.list()).items).toEqual([]);
    expect(s.app.db.query("select * from upload_staged").all()).toEqual([]);
    expect(s.app.db.query("select * from upload_staged_files").all()).toEqual(
      [],
    );
  } finally {
    await s.close();
  }
});

test("archive detection uses bytes, not the picked extension", async () => {
  const s = await setupUploads();
  try {
    const archive = await staged(
      await s.upload({
        name: "folder",
        body: await new Bun.Archive({ "Note.md": "hello" }).bytes(),
      }),
    );
    expect(archive).toMatchObject({
      archive: true,
      folder: "folder",
      saved: ["folder/note.md"],
    });
    const loose = await staged(
      await s.upload({ name: "not-an-archive.zip", body: "text" }),
    );
    expect(loose).toMatchObject({
      archive: false,
      folder: "",
      saved: ["not-an-archive.zip"],
    });
    const broken = await s.upload({ body: "PK\u0003\u0004broken" });
    expect(broken.status).toBe(400);
    expect((await s.list()).items).toHaveLength(2);
  } finally {
    await s.close();
  }
});

test.each([
  {
    name: "binary.png",
    body: async () => new Uint8Array([0, 255]),
    archive: false,
    skipped: 1,
  },
  {
    name: "all.tar",
    body: () => new Bun.Archive({ binary: new Uint8Array([0]) }).bytes(),
    archive: true,
    skipped: 1,
  },
  {
    name: "empty.zip",
    body: () => archiveFixture("empty.zip"),
    archive: true,
    skipped: 0,
  },
  {
    name: "empty.tgz",
    body: async () => Bun.gzipSync(await new Bun.Archive({}).bytes()),
    archive: true,
    skipped: 0,
  },
  {
    name: "directories.tar",
    body: async () => {
      const tar = await archiveFixture("types.tar");
      expect(tar[156]).toBe(0x35);
      return Buffer.concat([tar.subarray(0, 512), new Uint8Array(1024)]);
    },
    archive: true,
    skipped: 0,
  },
  {
    name: "left-out.tar",
    body: () =>
      new Bun.Archive({
        ".git/HEAD": "ref",
        "__MACOSX/file": "metadata",
      }).bytes(),
    archive: true,
    skipped: 0,
  },
  {
    name: ".DS_Store",
    body: async () => new Uint8Array([0]),
    archive: false,
    skipped: 0,
  },
])(
  "$name with no eligible files answers without staging",
  async ({ name, body, archive, skipped }) => {
    const s = await setupUploads();
    try {
      const item = await staged(await s.upload({ name, body: await body() }));
      expect(item).toMatchObject({
        id: null,
        expiresAt: null,
        files: 0,
        bytes: 0,
        saved: [],
        archive,
        skippedTotal: skipped,
      });
      expect((await s.list()).items).toEqual([]);
      expect(
        s.app.db.query("select count(*) as n from upload_staged").get(),
      ).toEqual({ n: 0 });
      expect(
        s.app.db.query("select count(*) as n from upload_staged_files").get(),
      ).toEqual({ n: 0 });
    } finally {
      await s.close();
    }
  },
);

test.each([
  ["attempt=try", "name is required once"],
  ["name=&attempt=try", "name is required once"],
  ["name=a&name=b&attempt=try", "name is required once"],
  ["name=archive.zip", "attempt is required once"],
  ["name=a&attempt=&attempt=b", "attempt is required once"],
  ["name=a&attempt=", "attempt is required once"],
  ["name=a&attempt=has+spaces", "attempt must be an id"],
  [`name=a&attempt=${"x".repeat(81)}`, "attempt must be an id"],
  ["name=a&attempt=try&folder=docs", "unknown upload parameter"],
])(
  "staging refuses invalid query %s before pulling the body",
  async (query, words) => {
    const s = await setupUploads();
    let pulled = false;
    try {
      const response = await s.upload({
        query,
        body: new ReadableStream(
          {
            pull() {
              pulled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(words);
      expect(pulled).toBe(false);
      expect((await s.list()).items).toEqual([]);
    } finally {
      await s.close();
    }
  },
);

test("attempts are unique per user across projects and lost answers are listed", async () => {
  const s = await setupUploads();
  try {
    const item = await staged(await s.upload({ attempt: "recover-me" }));
    const repeated = await s.upload({ attempt: "recover-me" });
    expect(repeated.status).toBe(409);
    expect((await repeated.json()).error).toContain("attempt");
    const team = s.app.projects.createTeam({
      ownerId: s.owner.id,
      name: "another",
      description: "",
      now: s.app.now.value,
    });
    s.app.projects.addMember(team.id, s.owner.id, s.app.now.value);
    expect(
      (await s.upload({ attempt: "recover-me", projectId: team.id })).status,
    ).toBe(409);
    expect(
      await staged(
        await s.upload({
          attempt: "recover-me",
          projectId: s.adminProjectId,
          cookie: s.admin.cookie,
        }),
      ),
    ).toMatchObject({ attempt: item.attempt });
    expect((await s.list()).items).toEqual([item]);
  } finally {
    await s.close();
  }
});

test("display names are cut before persistence, answers and skipped outcomes", async () => {
  const s = await setupUploads();
  try {
    const raw = `${"\u0001".repeat(200)}docs.zip`;
    const item = await staged(
      await s.upload({
        name: raw,
        body: await new Bun.Archive({ "ok.md": "text" }).bytes(),
      }),
    );
    expect(item.name).toBe(skippedName(raw));
    expect(Buffer.byteLength(JSON.stringify(item.name))).toBeLessThanOrEqual(
      300,
    );
    expect(item.saved).toEqual(["docs/ok.md"]);
    expect((await s.list()).items).toEqual([item]);
    const row = s.app.db
      .query<{ name: string; result: string }, [string]>(
        "select name, result from upload_staged where id = ?",
      )
      .get(item.id!);
    expect(row!.name).toBe(item.name);
    expect(JSON.parse(row!.result)).toEqual(item);
    const long = await staged(await s.upload({ name: "a".repeat(1000) }));
    expect(long).toMatchObject({
      id: null,
      name: "a".repeat(200),
      skipped: [{ name: "a".repeat(200), reason: "too-long" }],
    });
  } finally {
    await s.close();
  }
});

test("two thousand empty archive files still spend the file quota", async () => {
  const s = await setupUploads();
  try {
    const body = await new Bun.Archive(
      Object.fromEntries(
        Array.from({ length: 2000 }, (_, i) => [`file${i}`, ""]),
      ),
    ).bytes();
    const response = await s.upload({ name: "empty-files.tar", body });
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error).toContain("2000");
    expect(error).toContain("1000");
    expect((await s.list()).items).toEqual([]);
  } finally {
    await s.close();
  }
});

test("the staged file quota counts all items including repeated empty names", async () => {
  const s = await setupUploads();
  try {
    await s.limits({ uploadFiles: 10 });
    const body = await new Bun.Archive(
      Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`file${i}`, ""])),
    ).bytes();
    const first = await staged(await s.upload({ name: "same.tar", body }));
    expect(first).toMatchObject({ files: 6, bytes: 0 });
    const response = await s.upload({ name: "same.tar", body });
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error).toContain("12");
    expect(error).toContain("10");
    expect((await s.list()).items).toEqual([first]);
  } finally {
    await s.close();
  }
});

test("staged byte limits refuse a single oversized item and combined items", async () => {
  const s = await setupUploads();
  const cap = 1024 * 1024;
  try {
    await s.limits({ uploadBytes: cap, knowledgeFileBytes: 2 * cap });
    const response = await s.upload({ body: "x".repeat(cap + 1) });
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error).toContain(`${cap + 1}`);
    expect(error).toContain(`${cap}`);
    const first = await staged(await s.upload({ body: "x".repeat(cap) }));
    const second = await s.upload({ body: "x" });
    expect(second.status).toBe(400);
    expect((await second.json()).error).toContain(`${cap + 1}`);
    expect((await s.list()).items).toEqual([first]);
    const empty = await staged(await s.upload({ name: "empty", body: "" }));
    expect(empty).toMatchObject({ files: 1, bytes: 0 });
  } finally {
    await s.close();
  }
});

test("expired items neither list nor count before the hourly sweep", async () => {
  const s = await setupUploads();
  try {
    for (let i = 0; i < MAX_STAGED_ITEMS; i++) {
      await staged(await s.upload({ body: "" }));
    }
    const response = await s.upload();
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error).toContain("21");
    expect(error).toContain(`${MAX_STAGED_ITEMS}`);
    expect(
      await staged(
        await s.upload({
          name: ".DS_Store",
          body: new Uint8Array([0]),
        }),
      ),
    ).toMatchObject({ id: null, files: 0 });
    s.app.now.value += UPLOAD_LEASE_MS;
    expect((await s.list()).items).toEqual([]);
    expect(
      s.app.db.query("select count(*) as n from upload_staged").get(),
    ).toEqual({
      n: MAX_STAGED_ITEMS,
    });
    const fresh = await staged(await s.upload());
    expect(s.app.sweep()).toBe(MAX_STAGED_ITEMS);
    expect((await s.list()).items).toEqual([fresh]);
    expect(
      s.app.db.query("select count(*) as n from upload_staged_files").get(),
    ).toEqual({ n: 1 });
  } finally {
    await s.close();
  }
});

test("expired files and bytes leave room even when their rows remain", async () => {
  const s = await setupUploads();
  const cap = 1024 * 1024;
  try {
    await s.limits({
      uploadFiles: 10,
      uploadBytes: cap,
      knowledgeFileBytes: cap,
    });
    const body = await new Bun.Archive(
      Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [
          `file${i}`,
          i === 0 ? "x".repeat(cap) : "",
        ]),
      ),
    ).bytes();
    const expired = await staged(await s.upload({ name: "docs.tar", body }));
    expect(expired).toMatchObject({ files: 10, bytes: cap });
    s.app.now.value += UPLOAD_LEASE_MS;
    const fresh = await staged(await s.upload({ name: "docs.tar", body }));
    expect((await s.list()).items).toEqual([fresh]);
    expect(
      s.app.db.query("select count(*) as n from upload_staged").get(),
    ).toEqual({ n: 2 });
    expect((await s.call("DELETE", `/${expired.id}`)).status).toBe(404);
  } finally {
    await s.close();
  }
});

test("the full staged answer stays under 128 KiB and stores both bounded lists", async () => {
  const s = await setupUploads();
  try {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1800; i++) {
      files[`${"\u0001".repeat(200)}${"!".repeat(i + 1)}a.md`] = "skip";
    }
    for (let i = 0; i < 200; i++) {
      files[`${"a".repeat(80)}/${"b".repeat(80)}/${i}`] = "";
    }
    const response = await s.upload({
      name: "\u0001".repeat(200),
      body: await new Bun.Archive(files).bytes(),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(Buffer.byteLength(body)).toBeLessThan(128 * 1024);
    const item = JSON.parse(body);
    expect(item).toMatchObject({ files: 200, skippedTotal: 1800 });
    expect(item.saved).toHaveLength(200);
    expect(item.skipped).toHaveLength(200);
    expect((await s.list()).items).toEqual([item]);
  } finally {
    await s.close();
  }
});
