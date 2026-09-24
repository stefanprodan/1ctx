// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  type Document,
  type Inventory,
  loadKnowledge,
  parse,
} from "../../../src/server/provision/index.ts";
import { preflight } from "../../../src/server/provision/parse.ts";
import type { KnowledgeVersionsResponse } from "../../../src/shared/api/knowledge.ts";
import { testApp } from "../../helpers/app.ts";
import { mutations, object } from "./helpers.ts";

type Tree = Record<string, string | Uint8Array>;

async function folder(files: Tree): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "1ctx-provision-"));
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  return root;
}

async function write(root: string, name: string, body: string) {
  await mkdir(dirname(join(root, name)), { recursive: true });
  await writeFile(join(root, name), body);
}

function project(root: string, spec: Record<string, unknown>) {
  return parse([
    {
      path: join(root, "instance.yaml"),
      text: JSON.stringify(object("Project", "nebula", spec)),
    },
  ]);
}

const docsOf = (documents: Document[]) =>
  documents[0]?.kind === "Project" ? documents[0].docs : undefined;

const inventory: Inventory = {
  User: ["admin"],
  Project: ["nebula"],
  Provider: [],
  Skill: [],
  McpServer: [],
  Agent: [],
  Tool: ["web", "websearch", "visualize"],
};
const web = { mode: "all" as const, domains: [] };

describe("provision knowledge folder", () => {
  test("reads every doc by its path, in its case, and leaves out metadata", async () => {
    const root = await folder({
      "kb/README.md": "# Notes\n",
      "kb/guides/Setup.md": "﻿steps\n",
      "kb/.env.example": "KEY=\n",
      "kb/.DS_Store": "x",
      "kb/guides/._Setup.md": "x",
      "kb/__MACOSX/guides/Setup.md": "x",
      "kb/.git/HEAD": "ref: refs/heads/main\n",
    });
    const docs = docsOf(
      await loadKnowledge(project(root, { knowledge: "kb" })),
    );
    expect(docs).toEqual([
      { name: ".env.example", text: "KEY=\n", bytes: 5 },
      { name: "README.md", text: "# Notes\n", bytes: 8 },
      { name: "guides/Setup.md", text: "steps\n", bytes: 6 },
    ]);
  });

  test("a project without the field reads nothing", async () => {
    const root = await folder({});
    const documents = project(root, { description: "No docs" });
    expect(await loadKnowledge(documents)).toEqual(documents);
  });

  test.each([["/abs/kb"], ["kb/../other"], ["kb\\docs"], [""]])(
    "refuses the folder path %p when parsing",
    async (path) => {
      const root = await folder({});
      expect(() => project(root, { knowledge: path })).toThrow(
        "spec.knowledge: must be a relative folder path without ..",
      );
    },
  );

  test("refuses a document read from stdin", async () => {
    const documents = parse([
      {
        path: "-",
        text: JSON.stringify(object("Project", "nebula", { knowledge: "kb" })),
      },
    ]);
    await expect(loadKnowledge(documents)).rejects.toThrow(
      "-: Project/nebula: spec.knowledge needs a file to be relative to, not stdin",
    );
  });

  test.each([
    [{}, "kb", "kb: does not exist"],
    [{ kb: "a file" }, "kb", "kb: is not a folder"],
    [{ "kb/bad name.md": "x" }, "kb", "kb/bad name.md: is not a valid name"],
    [
      { "kb/logo.png": new Uint8Array([0x89, 0x50, 0x00, 0x47]) },
      "kb",
      "kb/logo.png: is not a text file",
    ],
    [
      { "kb/bad.md": new Uint8Array([0xc3, 0x28]) },
      "kb",
      "kb/bad.md: is not a text file",
    ],
  ] as [Tree, string, string][])(
    "refuses %p before anything is written",
    async (files, path, message) => {
      const root = await folder(files);
      await expect(
        loadKnowledge(project(root, { knowledge: path })),
      ).rejects.toThrow(`Project/nebula: spec.knowledge ${message}`);
    },
  );

  test("refuses a symlink, as the folder or inside it", async () => {
    const root = await folder({ "real/a.md": "a\n", "outside.md": "o\n" });
    await symlink(join(root, "real"), join(root, "kb"));
    await expect(
      loadKnowledge(project(root, { knowledge: "kb" })),
    ).rejects.toThrow("spec.knowledge kb: is a symlink");
    await symlink(join(root, "outside.md"), join(root, "real/link.md"));
    await expect(
      loadKnowledge(project(root, { knowledge: "real" })),
    ).rejects.toThrow("spec.knowledge real/link.md: is a symlink");
  });
});

describe("provision knowledge preflight", () => {
  const check = async (
    files: Tree,
    live: { name: string; bytes: number }[],
    caps: Partial<typeof DEFAULT_LIMITS> = {},
  ) => {
    const root = await folder(files);
    const documents = await loadKnowledge(project(root, { knowledge: "kb" }));
    return () =>
      preflight(
        documents,
        inventory,
        () => null,
        web,
        () => ({
          caps: { ...DEFAULT_LIMITS, ...caps },
          live,
        }),
      );
  };

  test("a doc over the size limit is refused, a smaller replacement is not", async () => {
    const over = await check({ "kb/big.md": "12345" }, [], {
      knowledgeFileBytes: 4,
    });
    expect(over).toThrow(
      "Project/nebula: spec.knowledge big.md is 5 bytes, the limit is 4",
    );
    const shrinking = await check(
      { "kb/big.md": "12345" },
      [{ name: "big.md", bytes: 9 }],
      { knowledgeFileBytes: 4 },
    );
    expect(shrinking).not.toThrow();
  });

  test("a name clashing with a live doc the folder does not name is refused", async () => {
    const run = await check({ "kb/notes/a.md": "a" }, [
      { name: "notes", bytes: 1 },
    ]);
    expect(run).toThrow(
      "Project/nebula: spec.knowledge notes/a.md conflicts with file notes",
    );
  });

  test("the project's other live docs count toward its totals", async () => {
    const run = await check(
      { "kb/a.md": "a", "kb/b.md": "b" },
      [{ name: "old.md", bytes: 1 }],
      { knowledgeFiles: 2 },
    );
    expect(run).toThrow(
      "Project/nebula: spec.knowledge the base would have 3 files, the limit is 2",
    );
  });
});

describe("provision knowledge apply", () => {
  test.serial(
    "creates, replaces, keeps and never prunes, reporting each doc written",
    async () => {
      const app = await testApp({ activate: false });
      try {
        const root = await folder({
          "kb/guide.md": "first\n",
          "kb/deep/notes.md": "notes\n",
        });
        const load = () => loadKnowledge(project(root, { knowledge: "kb" }));
        const lines: string[] = [];
        const counts = await app.provision.apply(await load(), (line) =>
          lines.push(line),
        );
        expect(lines).toEqual([
          "bootstrapped user/admin from user-admin.key",
          "created project/nebula",
          "created knowledge/nebula/deep/notes.md",
          "created knowledge/nebula/guide.md",
          "3 created, 0 updated, 0 unchanged",
        ]);
        expect(counts.created).toBe(3);
        const id = app.projects.teamProjectIds()[0]!;
        const guide = app.knowledge.store.byName(id, "guide.md")!;
        expect(guide.text).toBe("first\n");
        expect(guide.revision).toBe(1);

        const writes = mutations(app.db);
        lines.length = 0;
        await app.provision.apply(await load(), (line) => lines.push(line));
        expect(lines).toEqual([
          "unchanged project/nebula",
          "0 created, 0 updated, 1 unchanged",
        ]);
        expect(writes()).toEqual([]);

        const admin = app.client();
        await admin.login("admin", "hunter2-test");
        const base = `/api/projects/${id}/knowledge`;
        const made = await admin.call("POST", base, {
          body: { name: "by-hand.md", text: "kept\n" },
        });
        expect(made.status).toBe(201);
        const notes = app.knowledge.store.byName(id, "deep/notes.md")!;
        const gone = await admin.call("DELETE", `${base}/files/${notes.id}`);
        expect(gone.status).toBe(204);

        await write(root, "kb/guide.md", "second\n");
        lines.length = 0;
        await app.provision.apply(await load(), (line) => lines.push(line));
        expect(lines).toEqual([
          "unchanged project/nebula",
          "created knowledge/nebula/deep/notes.md",
          "updated knowledge/nebula/guide.md",
          "1 created, 1 updated, 1 unchanged",
        ]);
        const replaced = app.knowledge.store.byName(id, "guide.md")!;
        expect(replaced.id).toBe(guide.id);
        expect(replaced.text).toBe("second\n");
        expect(replaced.revision).toBe(2);
        expect(app.knowledge.store.byName(id, "deep/notes.md")!.id).not.toBe(
          notes.id,
        );
        expect(app.knowledge.store.byName(id, "by-hand.md")!.text).toBe(
          "kept\n",
        );
        const history = await admin.call(
          "GET",
          `${base}/files/${guide.id}/versions`,
        );
        const { versions } =
          (await history.json()) as KnowledgeVersionsResponse;
        expect(versions.map((version) => version.revision).sort()).toEqual([
          1, 2,
        ]);
      } finally {
        await app.shutdown();
        app.db.close();
      }
    },
  );

  test("a refused doc stops the apply and names the file", async () => {
    const app = await testApp({ activate: false });
    try {
      const root = await folder({ "kb/notes/a.md": "a\n" });
      await app.provision.apply(
        parse([
          {
            path: join(root, "instance.yaml"),
            text: JSON.stringify(object("Project", "nebula", {})),
          },
        ]),
        () => {},
      );
      const id = app.projects.teamProjectIds()[0]!;
      const admin = app.client();
      await admin.login("admin", "hunter2-test");
      await admin.call("POST", `/api/projects/${id}/knowledge`, {
        body: { name: "notes", text: "in the way\n" },
      });
      const documents = await loadKnowledge(project(root, { knowledge: "kb" }));
      await expect(app.provision.apply(documents, () => {})).rejects.toThrow(
        "Project/nebula: spec.knowledge notes/a.md conflicts with file notes",
      );
      expect(app.knowledge.store.byName(id, "notes/a.md")).toBeNull();
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });
});
