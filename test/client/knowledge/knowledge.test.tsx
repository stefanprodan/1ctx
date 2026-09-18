// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Knowledge tab: the words and the checks of its model, the HTML of
// the card, an open row and the Deleted card, and the entity applying a
// knowledge frame to the list it holds.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  applyKnowledge,
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
  fieldOf,
  headLine,
  knowledgeWords,
  lastLiveVersion,
  nameProblem,
  shownFiles,
  textBox,
  textProblem,
  versionLine,
} from "../../../src/client/views/knowledge/Knowledge.model.ts";
import { Knowledge } from "../../../src/client/views/knowledge/Knowledge.tsx";
import { KnowledgeForm } from "../../../src/client/views/knowledge/KnowledgeForm.tsx";
import { KnowledgeRow } from "../../../src/client/views/knowledge/KnowledgeRow.tsx";
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

const caelea: Me = {
  id: "u1",
  username: "caelea",
  fullName: "Oana Mangiurea",
  role: "member",
  mustChangePassword: false,
};

const byUser: KnowledgeAuthor = {
  kind: "user",
  id: "u1",
  name: "caelea",
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
  me.value = caelea;
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
      "6 files · 6.6k tokens",
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
    expect(user.href).toBe("/users/caelea");
    expect(user.handle).toBe(true);
    // a write from the page belongs to no session
    expect(user.where).toBeNull();
  });

  test("the text folds at twelve lines and says how many there are", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const folded = textBox(long, false);
    expect(folded.canToggle).toBe(true);
    expect(folded.text.split("\n")).toHaveLength(12);
    expect(folded.label).toBe("Show all 20 lines");
    const open = textBox(long, true);
    expect(open.text).toBe(long);
    expect(open.label).toBe("Show less");
    const short = textBox("one\ntwo\n", false);
    expect(short.canToggle).toBe(false);
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

describe("the add checks", () => {
  const names = ["docs", "notes/old.md"];

  test("a name is one to eight segments, free of the live names", () => {
    expect(nameProblem("", names)).toBe("Enter a name");
    expect(nameProblem("docs/../x", names)).toContain("One to eight segments");
    expect(nameProblem("notes/old.md", names)).toBe(
      "a file named notes/old.md exists",
    );
    // no file is another file's directory, either way round
    expect(nameProblem("docs/x.md", names)).toBe("docs is a file");
    expect(nameProblem("notes", names)).toBe("notes/old.md is inside it");
    expect(nameProblem(" runbook.md ", names)).toBeNull();
  });

  test("a text is asked for", () => {
    expect(textProblem("")).toBe("Add some text");
    expect(textProblem("hello")).toBeNull();
  });

  test("the server's words land at the field they are about", () => {
    expect(fieldOf("a file named docs/x.md exists")).toBe("name");
    expect(fieldOf("docs is a file")).toBe("name");
    expect(fieldOf("name must be one to eight segments")).toBe("name");
    expect(fieldOf("not a text file")).toBe("text");
    expect(fieldOf("the project is over its cap")).toBeUndefined();
  });
});

describe("the page", () => {
  test.serial("the card heads with the search, the totals and Add file", () => {
    lists.value = new Map([["p1", list()]]);
    const html = render(<Knowledge params={{ id: "p1" }} />);
    expect(html).toContain('placeholder="Search files"');
    expect(html).toContain("1 file · 620 tokens");
    expect(html).toContain("Add file");
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
      "the server refused this",
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

  test.serial("the add form takes a name and a text", () => {
    const html = render(
      <KnowledgeForm projectId="p1" names={[]} onDone={() => {}} />,
    );
    expect(html).toContain('name="name"');
    expect(html).toContain('name="text"');
    expect(html).toContain("One to eight segments");
    expect(html).toContain("Cancel");
  });
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
