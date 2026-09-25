// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Knowledge card's search results and its Deleted list, drawn to
// HTML: the names and the files with their marked lines, the pages
// left, Empty bin asking in the head and a refusal at its row.

import { beforeEach, describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { render } from "preact-render-to-string";
import {
  type KnowledgeSearch,
  searches,
} from "../../../src/client/data/knowledge-search.ts";
import { me } from "../../../src/client/data/me.ts";
import { Save } from "../../../src/client/lib/save.ts";
import {
  type Bin,
  DeletedList,
  EmptyBin,
} from "../../../src/client/views/knowledge/KnowledgeLists.tsx";
import { SearchResults } from "../../../src/client/views/knowledge/KnowledgeSearch.tsx";
import type {
  KnowledgeAuthor,
  KnowledgeDeleted,
  KnowledgeFile,
  KnowledgeSearchHit,
} from "../../../src/shared/contracts/knowledge.ts";

const NOW = Date.now();

const byAgent: KnowledgeAuthor = {
  kind: "agent",
  id: "a1",
  name: "sre",
  sessionId: "s1",
  origin: "chat",
};

function file(id: string, name: string): KnowledgeFile {
  return {
    id,
    projectId: "p1",
    name,
    kind: "md",
    bytes: 100,
    lines: 10,
    tokens: 30,
    revision: 2,
    author: byAgent,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3_600_000,
  };
}

function hit(id: string, name: string): KnowledgeSearchHit {
  return {
    file: file(id, name),
    count: 5,
    lines: [
      { line: 3, text: "Deploy the app", cutStart: false, cutEnd: false },
      {
        line: 40,
        text: "then deploy it again and DEPLOY",
        cutStart: true,
        cutEnd: true,
      },
    ],
  };
}

function search(changes: Partial<KnowledgeSearch> = {}): KnowledgeSearch {
  return {
    q: "deploy",
    state: "done",
    names: [],
    namesTotal: 0,
    files: [],
    next: null,
    failure: null,
    more: { loading: false, failure: null },
    ...changes,
  };
}

const draw = (value: KnowledgeSearch) => {
  searches.value = new Map([["p1", value]]);
  return render(<SearchResults projectId="p1" now={NOW} />);
};

beforeEach(() => {
  me.value = {
    id: "u1",
    username: "casey",
    fullName: "Casey Doe",
    role: "member",
    mustChangePassword: false,
  };
  searches.value = new Map();
});

describe("the search results", () => {
  test.serial("names come five at a time, then Show more", () => {
    const names = Array.from({ length: 7 }, (_, i) =>
      file(`n${i}`, `deploy/${i}.md`),
    );
    const html = draw(search({ names, namesTotal: 7 }));
    expect(html).toContain("Names · 7");
    expect(html).not.toContain("/5.md");
    expect(html.split('href="/projects/p1/knowledge/files/n').length - 1).toBe(
      5,
    );
    expect(html).toContain("Show more");
    expect(html).not.toContain("In files");
  });

  test.serial("a name is marked and its folder is faint", () => {
    const html = draw(
      search({ names: [file("n1", "ops/Deploy.md")], namesTotal: 1 }),
    );
    expect(html).toContain('<span class="knowledge-dir">ops/</span>');
    expect(html).toContain('<mark class="knowledge-mark">Deploy</mark>');
    expect(html).not.toContain("Show more");
  });

  test.serial("a file lists its lines with every match marked", () => {
    const html = draw(search({ files: [hit("f1", "runbook.md")] }));
    expect(html).toContain("In files");
    expect(html).toContain("5 lines");
    expect(html).toContain('href="/projects/p1/knowledge/files/f1?line=3"');
    expect(html).toContain('href="/projects/p1/knowledge/files/f1?line=40"');
    expect(html).toContain('<mark class="knowledge-mark">Deploy</mark> the');
    expect(html).toContain(
      '…then <mark class="knowledge-mark">deploy</mark> it again and ' +
        '<mark class="knowledge-mark">DEPLOY</mark>…',
    );
  });

  test.serial("a later page is Show more, then placeholders", () => {
    const files = [hit("f1", "runbook.md")];
    expect(draw(search({ files, next: "runbook.md" }))).toContain("Show more");
    const loading = draw(
      search({
        files,
        next: "runbook.md",
        more: { loading: true, failure: null },
      }),
    );
    expect(loading).not.toContain("Show more");
    expect(loading).toContain("stream-ghost");
    const failed = draw(
      search({
        files,
        next: "runbook.md",
        more: {
          loading: false,
          failure: { words: "the scan is busy", status: 429 },
        },
      }),
    );
    expect(failed).toContain("The scan is busy.");
    expect(failed).toContain("HTTP 429");
  });

  test.serial("nothing found, a first load and a failure say so", () => {
    expect(draw(search())).toContain("No file names or lines hold “deploy”.");
    expect(draw(search({ state: "loading" }))).toContain("Searching");
    const failed = draw(
      search({
        state: "failed",
        failure: { words: "the server refused this", status: 500 },
      }),
    );
    expect(failed).toContain("The server refused this.");
    expect(failed).toContain("HTTP 500");
  });
});

describe("the Deleted list", () => {
  const gone: KnowledgeDeleted = {
    ...file("f9", "old/notes.md"),
    deletedBy: byAgent,
    deletedAt: NOW - 2 * 86_400_000,
  };
  const bin = (asking = false, acting: string | null = null): Bin => ({
    save: new Save(async () => {}),
    asking: signal(asking),
    acting: signal(acting),
  });

  test("a row says who deleted it, and the list how long it is kept", () => {
    const html = render(
      <DeletedList
        projectId="p1"
        deleted={[gone]}
        historyDays={90}
        now={NOW}
        bin={bin()}
      />,
    );
    expect(html).toContain(
      '<span class="knowledge-dir">old/</span><span class="knowledge-base">notes.md</span>',
    );
    expect(html).toContain("deleted by ");
    expect(html.replace(/<[^>]*>/g, "")).toContain("@sre in a chat");
    expect(html).toContain("2d ago");
    expect(html).toContain('href="/projects/p1/knowledge/files/f9"');
    expect(html).toContain("Restore");
    expect(html).toContain("kept up to 90 days");
  });

  test("a refused Restore is said at its row's end, nowhere else", () => {
    const held = bin(false, "f9");
    held.save.status.value = {
      error: "a file named old/notes.md exists",
      action: "restore",
    };
    const html = render(
      <DeletedList
        projectId="p1"
        deleted={[gone, { ...gone, id: "f8", name: "old/other.md" }]}
        historyDays={90}
        now={NOW}
        bin={held}
      />,
    );
    const said = "Could not restore. A file named old/notes.md exists.";
    expect(html.split(said).length - 1).toBe(1);
    expect(html.indexOf(said)).toBeLessThan(html.indexOf("other.md"));
    expect(html).toContain("rows-end-error");
  });

  test("Empty bin asks in the head, and a refusal is said there", () => {
    expect(render(<EmptyBin projectId="p1" files={3} bin={bin()} />)).toContain(
      "Empty bin",
    );
    const asking = render(
      <EmptyBin projectId="p1" files={3} bin={bin(true)} />,
    );
    expect(asking).toContain(
      "Are you sure you want to permanently erase 3 files?",
    );
    expect(asking).toContain("Keep");
    expect(asking).toContain(">Erase<");
    const refused = bin(true);
    refused.save.status.value = {
      error: "the server refused",
      action: "empty",
    };
    const html = render(<EmptyBin projectId="p1" files={3} bin={refused} />);
    expect(html).toContain("Could not empty. The server refused.");
    expect(html).not.toContain("permanently erase");
  });
});
