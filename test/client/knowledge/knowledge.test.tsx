// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Knowledge tab: the words and the checks of its model, the HTML of
// the card, an open row and the Deleted card, and the entity applying a
// knowledge frame to the list it holds.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { options } from "preact";
import { render } from "preact-render-to-string";
import {
  applyKnowledge,
  emptyBin,
  fileTexts,
  fileVersions,
  listErrors,
  lists,
  loadKnowledge,
  onKnowledgeSocket,
  versionTexts,
} from "../../../src/client/data/knowledge.ts";
import { me } from "../../../src/client/data/me.ts";
import { project } from "../../../src/client/data/projects.ts";
import {
  authorOf,
  deletedHint,
  deletedLine,
  headLine,
  knowledgeWords,
  lastLiveVersion,
  shownFiles,
  sizeWords,
  textBox,
  versionLine,
} from "../../../src/client/views/knowledge/Knowledge.model.ts";
import { Knowledge } from "../../../src/client/views/knowledge/Knowledge.tsx";
import { KnowledgeRow } from "../../../src/client/views/knowledge/KnowledgeRow.tsx";
import { KnowledgeUpload } from "../../../src/client/views/knowledge/KnowledgeUpload.tsx";
import type {
  KnowledgeAuthor,
  KnowledgeDeleted,
  KnowledgeFile,
  KnowledgeList,
  KnowledgeVersion,
} from "../../../src/shared/contracts/knowledge.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

// the page draws against the real clock, so the fixtures sit behind it
const NOW = Date.now();

const casey: Me = {
  id: "u1",
  username: "casey",
  fullName: "Casey Doe",
  role: "member",
  mustChangePassword: false,
};

const byUser: KnowledgeAuthor = {
  kind: "user",
  id: "u1",
  name: "casey",
  sessionId: null,
  origin: null,
};

const byAgent: KnowledgeAuthor = {
  kind: "agent",
  id: "a1",
  name: "sre",
  sessionId: "s1",
  origin: "automation",
};

function file(changes: Partial<KnowledgeFile> = {}): KnowledgeFile {
  return {
    id: "f1",
    projectId: "p1",
    name: "docs/runbook.md",
    kind: "md",
    bytes: 2048,
    lines: 84,
    tokens: 620,
    revision: 3,
    author: byAgent,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 7_200_000,
    ...changes,
  };
}

function version(changes: Partial<KnowledgeVersion> = {}): KnowledgeVersion {
  return {
    id: "v3",
    fileId: "f1",
    name: "docs/runbook.md",
    revision: 3,
    bytes: 2048,
    lines: 84,
    author: byAgent,
    writtenAt: NOW - 7_200_000,
    deleted: false,
    ...changes,
  };
}

function deleted(changes: Partial<KnowledgeDeleted> = {}): KnowledgeDeleted {
  return {
    ...file({ id: "f9", name: "notes/old.md", revision: 4 }),
    deletedBy: byAgent,
    deletedAt: NOW - 4 * 86_400_000,
    ...changes,
  };
}

function list(changes: Partial<KnowledgeList> = {}): KnowledgeList {
  const files = changes.files ?? [file()];
  return {
    files,
    deleted: [],
    totals: {
      files: files.length,
      bytes: files.reduce((n, row) => n + row.bytes, 0),
      tokens: files.reduce((n, row) => n + row.tokens, 0),
    },
    limits: {
      fileBytes: 262_144,
      files: 500,
      projectBytes: 16_777_216,
      historyDays: 90,
    },
    ...changes,
  };
}

const shown = {
  id: "p1",
  kind: "personal" as const,
  name: "personal",
  createdAt: NOW - 30 * 86_400_000,
  memberCount: 1,
  description: "",
  members: [],
  chats: 2,
  knowledge: { files: 1, tokens: 620 },
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  me.value = casey;
  lists.value = new Map();
  listErrors.value = new Map();
  fileTexts.value = {};
  fileVersions.value = {};
  versionTexts.value = {};
  project.value = shown;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the knowledge words", () => {
  test("the totals read as files and tokens", () => {
    expect(knowledgeWords({ files: 6, tokens: 6600 })).toBe(
      "6 files · 6.6K tokens",
    );
    expect(knowledgeWords({ files: 1, tokens: 1 })).toBe("1 file · 1 token");
  });

  test("the head line names the kind, the lines, the author and when", () => {
    const head = headLine(file(), NOW);
    expect(head.kind).toBe("md");
    expect(head.lines).toBe("84 lines");
    expect(head.author.name).toBe("sre");
    expect(head.when).toBe("2h ago");
    // a name without an extension is still text
    expect(headLine(file({ kind: "", lines: 1 }), NOW).kind).toBe("text");
    expect(headLine(file({ lines: 1 }), NOW).lines).toBe("1 line");
  });

  test("an author is their page, and the write is its chat or its run", () => {
    const agent = authorOf(byAgent);
    expect(agent).toEqual({
      name: "sre",
      href: "/agents/sre",
      handle: false,
      where: "in a run",
      sessionId: "s1",
    });
    expect(authorOf({ ...byAgent, origin: "chat" }).where).toBe("in a chat");
    const user = authorOf(byUser);
    expect(user.href).toBe("/users/casey");
    expect(user.handle).toBe(true);
    // a write from the page belongs to no session
    expect(user.where).toBeNull();
  });

  test("the text folds at twelve lines and says how many there are", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const folded = textBox(long, false);
    expect(folded.cut).toBe(true);
    expect(folded.text.split("\n")).toHaveLength(12);
    expect(folded.label).toBe("Show all 20 lines");
    const open = textBox(long, true);
    expect(open.text).toBe(long);
    // open stays open: the row folds it again
    expect(open.label).toBe("Show all 20 lines");
    const short = textBox("one\ntwo\n", false);
    expect(short.cut).toBe(false);
    expect(short.text).toBe("one\ntwo\n");
  });

  test("a version line says the revision, who wrote it and which is current", () => {
    const line = versionLine(version(), true, NOW);
    expect(line.label).toBe("Revision 3");
    expect(line.current).toBe(true);
    expect(line.when).toBe("2h ago");
    expect(versionLine(version({ revision: 2 }), false, NOW).current).toBe(
      false,
    );
    expect(versionLine(version({ deleted: true }), false, NOW).deleted).toBe(
      true,
    );
  });

  test("Restore takes the newest version that still holds a text", () => {
    const versions = [
      version({ id: "v4", revision: 4, deleted: true }),
      version({ id: "v3", revision: 3 }),
    ];
    expect(lastLiveVersion(versions)?.id).toBe("v3");
    expect(lastLiveVersion([version({ deleted: true })])).toBeNull();
  });

  test("a deleted row says who deleted it and when", () => {
    const line = deletedLine(deleted(), NOW);
    expect(line.author.name).toBe("sre");
    expect(line.when).toBe("4d ago");
    expect(deletedHint(90)).toBe("kept 90 days");
    expect(deletedHint(1)).toBe("kept 1 day");
  });

  test("the search keeps the rows whose name holds it", () => {
    const rows = [file(), file({ id: "f2", name: "values.yaml" })];
    expect(shownFiles(rows, "yaml").map((row) => row.name)).toEqual([
      "values.yaml",
    ]);
    expect(shownFiles(rows, "")).toHaveLength(2);
  });
});

test("file sizes keep their units", () => {
  expect(sizeWords(262_144)).toBe("256 KB");
  expect(sizeWords(4 * 1024 * 1024)).toBe("4 MB");
  expect(sizeWords(1023)).toBe("1023 B");
  expect(sizeWords(5.78 * 1024 * 1024)).toBe("5.78 MB");
  expect(sizeWords(812 * 1024)).toBe("812 KB");
  // never a rounded thousand: the next unit takes over
  expect(sizeWords(1023.5 * 1024 * 1024)).toBe("1 GB");
  expect(sizeWords(1024 ** 3)).toBe("1 GB");
  expect(sizeWords(1.5 * 1024 ** 3)).toBe("1.5 GB");
});

describe("the page", () => {
  test.serial(
    "the form prevents file-drop navigation even without a drop target",
    () => {
      const previous = options.vnode;
      let drop: ((event: Event) => void) | undefined;
      let drag: ((event: Event) => void) | undefined;
      options.vnode = (node) => {
        previous?.(node);
        const props = node.props;
        if (
          node.type === "form" &&
          "class" in props &&
          props.class === "knowledge-form"
        ) {
          if ("onDrop" in props && typeof props.onDrop === "function") {
            const handler = props.onDrop;
            drop = (event) => handler(event);
          }
          if ("onDragOver" in props && typeof props.onDragOver === "function") {
            const handler = props.onDragOver;
            drag = (event) => handler(event);
          }
        }
      };
      try {
        render(
          <KnowledgeUpload
            projectId="p1"
            names={[]}
            limits={list().limits}
            onDone={() => {}}
          />,
        );
        for (const handler of [drop, drag]) {
          const event = new Event("drop", { cancelable: true });
          handler?.(event);
          expect(event.defaultPrevented).toBe(true);
        }
      } finally {
        options.vnode = previous;
      }
    },
  );

  test.serial("the card heads with the search, the totals and Upload", () => {
    lists.value = new Map([["p1", list()]]);
    const html = render(<Knowledge params={{ id: "p1" }} />);
    expect(html).toContain('placeholder="Search files"');
    expect(html).toContain("1 file · 620 tokens");
    expect(html).toContain("Upload");
    expect(html).not.toContain("Add file");
    expect(html).toContain("docs/runbook.md");
    // the head is a button, so it carries no link
    expect(html).not.toContain('href="/agents/sre"');
    expect(html).toContain("84 lines");
    expect(html).toContain("620 tokens");
    expect(html).toContain("Every agent in this project sees this list");
  });

  test.serial("an empty base says how a file gets there", () => {
    lists.value = new Map([["p1", list({ files: [] })]]);
    const html = render(<Knowledge params={{ id: "p1" }} />);
    expect(html).toContain("No files yet.");
    expect(html).toContain("bash tool");
    expect(html).not.toContain(">Deleted<");
  });

  test.serial("a failed load is the card's note", () => {
    listErrors.value = new Map([
      ["p1", { words: "the server refused this", status: 403 }],
    ]);
    expect(render(<Knowledge params={{ id: "p1" }} />)).toContain(
      "The server refused this.",
    );
  });

  test.serial("the Deleted card says who deleted each file", () => {
    lists.value = new Map([["p1", list({ deleted: [deleted()] })]]);
    const html = render(<Knowledge params={{ id: "p1" }} />);
    expect(html).toContain(">Deleted<");
    expect(html).toContain("kept 90 days");
    expect(html).toContain("notes/old.md");
    expect(html).toContain("deleted by ");
    expect(html).toContain("4d ago");
    expect(html).toContain("Restore");
  });

  test.serial("an open row links the author, the run and its history", () => {
    fileTexts.value = { f1: "# Runbook\nStep one\n" };
    fileVersions.value = {
      f1: [version(), version({ id: "v2", revision: 2, author: byUser })],
    };
    const html = render(
      <KnowledgeRow
        projectId="p1"
        file={file()}
        now={NOW}
        open
        onToggle={() => {}}
      />,
    );
    expect(html).toContain('href="/agents/sre"');
    expect(html).toContain('href="/chat/s1"');
    expect(html).toContain("# Runbook");
    expect(html).toContain(">History<");
    expect(html).toContain("Revision 3");
    expect(html).toContain("current");
    expect(html).toContain("Restore");
    expect(html).toContain("btn-danger");
  });

  test.serial(
    "the uploader takes a folder and multiple files, not a name or text",
    () => {
      const html = render(
        <KnowledgeUpload
          projectId="p1"
          names={[]}
          limits={list().limits}
          onDone={() => {}}
        />,
      );
      expect(html).toContain('name="folder"');
      expect(html).not.toContain('name="name"');
      expect(html).not.toContain("<textarea");
      expect(html).toContain("The root when empty");
      expect(html).toContain("Drop files or archives here");
      expect(html).toContain("Choose files");
      expect(html).toContain('type="file"');
      expect(html).toContain("multiple");
      expect(html).toContain("up to 32 MB each");
      expect(html).toContain("Cancel");
    },
  );
});

describe("a knowledge frame", () => {
  test.serial("an unknown file joins the list and the totals follow", () => {
    lists.value = new Map([["p1", list()]]);
    onKnowledgeSocket({
      type: "knowledge",
      projectId: "p1",
      file: file({ id: "f2", name: "values.yaml", bytes: 100, tokens: 30 }),
      deleted: false,
    });
    const held = lists.value.get("p1");
    expect(held?.files.map((row) => row.name)).toEqual([
      "docs/runbook.md",
      "values.yaml",
    ]);
    expect(held?.totals).toEqual({ files: 2, bytes: 2148, tokens: 650 });
  });

  test.serial(
    "a newer revision replaces the row and drops what was read",
    () => {
      lists.value = new Map([["p1", list()]]);
      fileTexts.value = { f1: "old" };
      fileVersions.value = { f1: [version()] };
      applyKnowledge("p1", file({ revision: 4, lines: 90 }), false);
      expect(lists.value.get("p1")?.files[0].revision).toBe(4);
      expect(fileTexts.value.f1).toBeUndefined();
      expect(fileVersions.value.f1).toBeUndefined();
    },
  );

  test.serial("a revision at or under the one held changes nothing", () => {
    lists.value = new Map([["p1", list()]]);
    const before = lists.value.get("p1");
    applyKnowledge("p1", file({ revision: 3, lines: 1 }), false);
    applyKnowledge("p1", file({ revision: 2, lines: 1 }), false);
    expect(lists.value.get("p1")).toBe(before);
  });

  test.serial("a delete moves the row to the Deleted card", () => {
    lists.value = new Map([["p1", list()]]);
    applyKnowledge("p1", file({ revision: 4, updatedAt: NOW }), true);
    const held = lists.value.get("p1");
    expect(held?.files).toHaveLength(0);
    expect(held?.totals).toEqual({ files: 0, bytes: 0, tokens: 0 });
    expect(held?.deleted[0].name).toBe("docs/runbook.md");
    expect(held?.deleted[0].deletedBy).toEqual(byAgent);
    expect(held?.deleted[0].deletedAt).toBe(NOW);
  });

  test.serial("a deleted name made again under a new id leaves Deleted", () => {
    lists.value = new Map([["p1", list()]]);
    applyKnowledge("p1", file({ revision: 4, updatedAt: NOW }), true);
    expect(lists.value.get("p1")?.deleted).toHaveLength(1);
    applyKnowledge("p1", file({ id: "f9", revision: 1 }), false);
    const held = lists.value.get("p1");
    expect(held?.files.map((row) => row.id)).toEqual(["f9"]);
    expect(held?.deleted).toHaveLength(0);
  });

  test.serial("emptying the bin clears the Deleted card", async () => {
    lists.value = new Map([["p1", list()]]);
    applyKnowledge("p1", file({ revision: 4, updatedAt: NOW }), true);
    expect(lists.value.get("p1")?.deleted).toHaveLength(1);
    globalThis.fetch = (async () =>
      Response.json({ files: 2 })) as unknown as typeof fetch;
    expect(await emptyBin("p1")).toBe(2);
    expect(lists.value.get("p1")?.deleted).toEqual([]);
  });

  test.serial("an emptied frame clears it for every other tab", () => {
    lists.value = new Map([["p1", list()]]);
    applyKnowledge("p1", file({ revision: 4, updatedAt: NOW }), true);
    onKnowledgeSocket({ type: "knowledgeEmptied", projectId: "p1" });
    expect(lists.value.get("p1")?.deleted).toEqual([]);
    expect(lists.value.get("p1")?.files).toHaveLength(0);
  });

  test.serial("nothing is applied to a project whose list is not held", () => {
    applyKnowledge("p1", file(), false);
    expect(lists.value.get("p1")).toBeUndefined();
  });

  test.serial("a list in flight never brings a deleted file back", async () => {
    lists.value = new Map([["p1", list()]]);
    let answer: (body: unknown) => void = () => {};
    globalThis.fetch = (async () =>
      new Promise((resolve) => {
        answer = (body) => resolve(Response.json(body));
      })) as unknown as typeof fetch;
    const loading = loadKnowledge("p1");
    applyKnowledge("p1", file({ revision: 4, updatedAt: NOW }), true);
    // the answer was on its way before the delete landed
    answer(list());
    await loading;
    const held = lists.value.get("p1");
    expect(held?.files).toHaveLength(0);
    expect(held?.deleted).toHaveLength(1);
  });
});
