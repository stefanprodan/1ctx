// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { parseSearch } from "../../../src/server/knowledge/parse.ts";
import {
  cursorOf,
  oneAtATime,
  readCursor,
  type SearchSource,
  search,
} from "../../../src/server/knowledge/search.ts";
import { BadRequest, HttpError } from "../../../src/server/lib/errors.ts";
import {
  SEARCH_LINE_CHARS,
  SEARCH_NAMES,
  SEARCH_PAGE,
} from "../../../src/shared/api/knowledge.ts";
import type { KnowledgeFile } from "../../../src/shared/contracts/knowledge.ts";
import {
  bestLines,
  holdsAll,
  searchTerms,
} from "../../../src/shared/search.ts";
import { type Setup, setup } from "./helpers.ts";

// the store's rows as the area reads them
const source = (s: Setup): SearchSource => ({
  files: () => s.area.store.files(s.projectId),
  text: (fileId) => s.area.store.text(s.projectId, fileId),
});

const names = (page: { files: { file: KnowledgeFile }[] }) =>
  page.files.map((hit) => hit.file.name);

// one text per name, the project made fresh
function project(files: Record<string, string>): Setup {
  const s = setup();
  for (const [name, text] of Object.entries(files)) {
    s.area.create(s.projectId, s.author, name, text);
  }
  return s;
}

function searched(files: Record<string, string>, q: string) {
  const s = project(files);
  try {
    return s.area.search(s.projectId, "u", q, null);
  } finally {
    s.db.close();
  }
}

// a text's hit as the search builds it, null when it misses a word
function matchText(text: string, q: string) {
  const terms = searchTerms(q);
  return holdsAll(text, terms) ? bestLines(text, terms) : null;
}

const url = (query: string) =>
  new URL(`http://x/api/projects/p/knowledge/search?${query}`);

describe("knowledge search", () => {
  test("counts matching lines in any case and keeps three, credited first", () => {
    const text = "Alpha\nbeta\nALPHA two\ngamma\nalphabet\nlast alpha";
    expect(matchText(text, "alpha")).toEqual({
      count: 4,
      lines: [
        { line: 1, text: "Alpha", cutStart: false, cutEnd: false },
        { line: 3, text: "ALPHA two", cutStart: false, cutEnd: false },
        { line: 6, text: "last alpha", cutStart: false, cutEnd: false },
      ],
    });
    expect(matchText(text, "delta")).toBeNull();
  });

  test("drops a carriage return and never matches across lines", () => {
    expect(matchText("one two\r\nthree", "two")?.lines).toEqual([
      { line: 1, text: "one two", cutStart: false, cutEnd: false },
    ]);
    expect(matchText("one\ntwo", '"one\ntwo"')).toBeNull();
  });

  test("cuts a long line round the first match", () => {
    const line = `${"a".repeat(300)}needle${"b".repeat(300)}`;
    const [hit] = matchText(line, "needle")!.lines;
    expect(hit!.text).toHaveLength(SEARCH_LINE_CHARS);
    expect(hit!.text).toContain("needle");
    expect(hit!.cutStart).toBe(true);
    expect(hit!.cutEnd).toBe(true);
    const at = hit!.text.indexOf("needle");
    expect(Math.abs(at - (SEARCH_LINE_CHARS - 6 - at))).toBeLessThanOrEqual(1);

    const start = matchText(`needle${"b".repeat(300)}`, "needle")!.lines[0]!;
    expect(start).toMatchObject({ cutStart: false, cutEnd: true });
    expect(start.text.startsWith("needle")).toBe(true);
    const end = matchText(`${"a".repeat(300)}needle`, "needle")!.lines[0]!;
    expect(end).toMatchObject({ cutStart: true, cutEnd: false });
    expect(end.text.endsWith("needle")).toBe(true);
  });

  test("finds a match where lowercasing changes the length", () => {
    // İ lowercases to two units, which shifts every later index
    const line = `${"İ".repeat(200)}Needle${"x".repeat(200)}`;
    const [hit] = matchText(line, "needle")!.lines;
    expect(hit!.text).toContain("Needle");
    expect(hit!.text.length).toBeLessThanOrEqual(SEARCH_LINE_CHARS);
  });

  test("never splits a surrogate pair at a cut", () => {
    const line = `${"😀".repeat(200)}needle${"😀".repeat(200)}`;
    const [hit] = matchText(line, "needle")!.lines;
    expect(hit!.text).toContain("needle");
    expect(hit!.text).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
  });

  test("pages the files by rank, shorter first at equal counts", () => {
    const s = setup();
    try {
      for (let i = 1; i <= SEARCH_PAGE + 2; i++) {
        const name = `notes/n${String(i).padStart(2, "0")}.md`;
        s.area.create(s.projectId, s.author, name, `line\nsome Topic ${i}\n`);
      }
      s.area.create(s.projectId, s.author, "other.md", "nothing here\n");
      const first = s.area.search(s.projectId, "u", "topic", null);
      expect(names(first)).toEqual(
        Array.from(
          { length: SEARCH_PAGE },
          (_, i) => `notes/n${String(i + 1).padStart(2, "0")}.md`,
        ),
      );
      expect(first.files[0]).toMatchObject({
        count: 1,
        lines: [{ line: 2, text: "some Topic 1" }],
      });
      expect(first.files[0]!.file).not.toHaveProperty("text");
      expect(readCursor(first.next!)?.name).toBe(`notes/n${SEARCH_PAGE}.md`);
      const second = s.area.search(s.projectId, "u", "topic", first.next);
      expect(names(second)).toEqual(["notes/n11.md", "notes/n12.md"]);
      expect(second.next).toBeNull();
      expect(second).toMatchObject({ names: [], namesTotal: 0 });
    } finally {
      s.db.close();
    }
  });

  test("a full last page has no next", () => {
    const s = setup();
    try {
      for (let i = 0; i < SEARCH_PAGE; i++) {
        s.area.create(s.projectId, s.author, `f${i}.txt`, "hit\n");
      }
      expect(s.area.search(s.projectId, "u", "hit", null).next).toBeNull();
    } finally {
      s.db.close();
    }
  });

  test("names come on the first page only, without the text hits", () => {
    const s = setup();
    try {
      s.area.create(s.projectId, s.author, "plans/Topic.md", "no words\n");
      s.area.create(s.projectId, s.author, "topics/both.md", "a topic\n");
      for (let i = 0; i < SEARCH_PAGE; i++) {
        s.area.create(s.projectId, s.author, `z${i}.md`, "the TOPIC\n");
      }
      const first = s.area.search(s.projectId, "u", "TOPIC", null);
      expect(first.names.map((file) => file.name)).toEqual(["plans/Topic.md"]);
      expect(first.namesTotal).toBe(1);
      expect(names(first)).toContain("topics/both.md");
      const later = s.area.search(s.projectId, "u", "topic", first.next);
      expect(later.names).toEqual([]);
      expect(later.namesTotal).toBe(0);
      expect(later.files).toHaveLength(1);
    } finally {
      s.db.close();
    }
  });

  test("names past a full page of text hits are still judged by their text", () => {
    const s = setup();
    try {
      for (let i = 0; i < SEARCH_PAGE + 1; i++) {
        s.area.create(s.projectId, s.author, `a${i}.md`, "key\n");
      }
      s.area.create(s.projectId, s.author, "z/key-text.md", "key\n");
      s.area.create(s.projectId, s.author, "z/key-name.md", "none\n");
      const page = s.area.search(s.projectId, "u", "key", null);
      expect(page.files).toHaveLength(SEARCH_PAGE);
      expect(page.names.map((file) => file.name)).toEqual(["z/key-name.md"]);
    } finally {
      s.db.close();
    }
  });

  test("caps the names and counts them all", () => {
    const s = setup();
    try {
      for (let i = 0; i < SEARCH_NAMES + 3; i++) {
        s.area.create(s.projectId, s.author, `match-${i}.txt`, "x\n");
      }
      const page = s.area.search(s.projectId, "u", "match", null);
      expect(page.names).toHaveLength(SEARCH_NAMES);
      expect(page.namesTotal).toBe(SEARCH_NAMES + 3);
      expect(page.files).toEqual([]);
      expect(page.next).toBeNull();
    } finally {
      s.db.close();
    }
  });

  test("a file matches when it holds every word, a name when it does", () => {
    const s = setup();
    try {
      s.area.create(
        s.projectId,
        s.author,
        "a.md",
        "the plan\nexternal tasks\n",
      );
      s.area.create(s.projectId, s.author, "b.md", "the plan\nexternal work\n");
      s.area.create(s.projectId, s.author, "plan/external-tasks.md", "x\n");
      s.area.create(s.projectId, s.author, "plan/other.md", "x\n");
      const page = s.area.search(s.projectId, "u", "plan External tasks", null);
      expect(names(page)).toEqual(["a.md"]);
      expect(page.files[0]!.count).toBe(2);
      expect(page.names.map((file) => file.name)).toEqual([
        "plan/external-tasks.md",
      ]);
      const phrase = s.area.search(s.projectId, "u", '"plan external"', null);
      expect(phrase.files).toEqual([]);
      expect(() => s.area.search(s.projectId, "u", '""', null)).toThrow(
        new BadRequest("q must hold a word"),
      );
    } finally {
      s.db.close();
    }
  });

  test("a file gone mid-scan is neither a text nor a name row", () => {
    const s = project({ "topic-a.md": "a topic\n", "topic-b.md": "none\n" });
    try {
      const gone = s.area.store.fileNamed(s.projectId, "topic-b.md")!.id;
      const page = search(
        {
          files: source(s).files,
          text: (fileId) =>
            fileId === gone ? null : s.area.store.text(s.projectId, fileId),
        },
        "topic",
        null,
      );
      expect(names(page)).toEqual(["topic-a.md"]);
      expect(page).toMatchObject({ names: [], namesTotal: 0 });
    } finally {
      s.db.close();
    }
  });

  test("a page row gone after the scan is left out, the cursor kept", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < SEARCH_PAGE + 2; i++) {
      files[`f${String(i).padStart(2, "0")}.md`] = "a topic\n";
    }
    const s = project(files);
    try {
      const gone = s.area.store.fileNamed(s.projectId, "f03.md")!.id;
      let reads = 0;
      const page = search(
        {
          files: source(s).files,
          // the scan reads it once; the page's second read finds it gone
          text: (fileId) =>
            fileId === gone && reads++ > 0
              ? null
              : s.area.store.text(s.projectId, fileId),
        },
        "topic",
        null,
      );
      expect(names(page)).toHaveLength(SEARCH_PAGE - 1);
      expect(names(page)).not.toContain("f03.md");
      expect(readCursor(page.next!)?.name).toBe("f09.md");
      const rest = s.area.search(s.projectId, "u", "topic", page.next);
      expect(names(rest)).toEqual(["f10.md", "f11.md"]);
    } finally {
      s.db.close();
    }
  });

  test("a page row that no longer holds every word is left out", () => {
    const s = project({ "a.md": "a topic\n", "b.md": "a topic\n" });
    try {
      const changed = s.area.store.fileNamed(s.projectId, "b.md")!.id;
      let reads = 0;
      const page = search(
        {
          files: source(s).files,
          text: (fileId) =>
            fileId === changed && reads++ > 0
              ? "no word here\n"
              : s.area.store.text(s.projectId, fileId),
        },
        "topic",
        null,
      );
      expect(names(page)).toEqual(["a.md"]);
      expect(page.next).toBeNull();
    } finally {
      s.db.close();
    }
  });

  test("runs one scan per user at a time", () => {
    const running = new Set<string>();
    const inner = () =>
      oneAtATime(running, "u1", () => oneAtATime(running, "u1", () => 1));
    let error: unknown;
    try {
      inner();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(429);
    expect((error as HttpError).message).toBe("a search is already running");
    expect(running.size).toBe(0);
    expect(
      oneAtATime(running, "u1", () => oneAtATime(running, "u2", () => 2)),
    ).toBe(2);
  });

  test("a cursor reads back to the same score and name", () => {
    for (const score of [0, 1, 1 / 3, 2.5e-7, 1e21, 12.345678901234567]) {
      expect(readCursor(cursorOf({ score, name: "docs/x.md" }))).toEqual({
        score,
        name: "docs/x.md",
      });
    }
  });

  test("parses q and after", () => {
    expect(parseSearch(url("q=%20ab%20"))).toEqual({ q: "ab", after: null });
    expect(parseSearch(url("q=abc&after=1.5:docs/x.md"))).toEqual({
      q: "abc",
      after: "1.5:docs/x.md",
    });
  });

  test.each([
    ["", "q must appear once"],
    ["q=a&q=b", "q must appear once"],
    ["q=a", "q must be 2 to 100 characters"],
    ["q=%20a%20", "q must be 2 to 100 characters"],
    [`q=${"x".repeat(101)}`, "q must be 2 to 100 characters"],
    ["q=a%0Ab", "q must be one line of text"],
    ["q=%22%22", "q must hold a word"],
    ["q=%22%20%22", "q must hold a word"],
    ["q=ab&after=x&after=y", "after must appear once"],
    ["q=ab&after=docs/x.md", "after must be a search cursor"],
    ["q=ab&after=1.5:../x", "after must be a search cursor"],
    ["q=ab&after=-1:x.md", "after must be a search cursor"],
    ["q=ab&after=NaN:x.md", "after must be a search cursor"],
    ["q=ab&after=", "after must be a search cursor"],
    ["q=ab&page=2", "unknown parameter page"],
  ])("refuses %j", (query, words) => {
    expect(() => parseSearch(url(query))).toThrow(new BadRequest(words));
  });
});

// a line of filler that holds no query word, to even out lengths
const pad = (text: string, bytes: number) =>
  `${text}\n${"x".repeat(Math.max(0, bytes - text.length - 2))}\n`;

describe("knowledge search ranking", () => {
  test("many credited hits rank above one", () => {
    const page = searched(
      {
        "a.md": pad("deploy once", 200),
        "b.md": pad("deploy, deploy again, deploy later", 200),
        "c.md": pad("deploy and deploy", 200),
      },
      "deploy",
    );
    expect(names(page)).toEqual(["b.md", "c.md", "a.md"]);
  });

  test("a word nearly every file holds still ranks more uses higher", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`f${i}.md`] = pad("the data", 100);
    files["z.md"] = pad("data data data data", 100);
    files["none.md"] = pad("nothing", 100);
    expect(names(searched(files, "data"))[0]).toBe("z.md");
  });

  test("a name holding every term lifts a file by at most half", () => {
    // equal lengths: one use scores 1, two 1.375, three 1.57 before IDF
    const page = searched(
      {
        "deploy.md": pad("deploy", 100),
        "b.md": pad("deploy deploy", 100),
        "c.md": pad("deploy deploy deploy", 100),
        "d.md": pad("none", 100),
      },
      "deploy",
    );
    expect(names(page)).toEqual(["c.md", "deploy.md", "b.md"]);
  });

  test("a name holding some terms lifts a file less", () => {
    const page = searched(
      {
        "a.md": pad("deploy notes", 100),
        "notes.md": pad("deploy notes", 100),
        "deploy-notes.md": pad("deploy notes", 100),
      },
      "deploy notes",
    );
    expect(names(page)).toEqual(["deploy-notes.md", "notes.md", "a.md"]);
  });

  test("ties go in name order", () => {
    const page = searched(
      { "z.md": "a topic\n", "a.md": "a topic\n", "m.md": "a topic\n" },
      "topic",
    );
    expect(names(page)).toEqual(["a.md", "m.md", "z.md"]);
  });

  test("the file about the words ranks above files that hold each once", () => {
    // each word once, release and claim inside other words
    const glancing: Record<string, string> = {};
    for (const name of ["a-notes.md", "b-ideas.md", "c-review.md"]) {
      glancing[name] = [
        "# Notes",
        "An idle thought about the pre-release build.",
        "See claimUploads in the store.",
        "x".repeat(2000),
      ].join("\n");
    }
    const about = [
      "# Idle release",
      "Summary: who may claim a task, and when.",
      ...Array.from(
        { length: 6 },
        (_, i) => `An idle claim ${i} sits until a release frees it.`,
      ),
      ...Array.from({ length: 14 }, (_, i) => `Each release ${i} is logged.`),
      ...Array.from({ length: 55 }, (_, i) => `A claim ${i} names its owner.`),
    ].join("\n");
    const page = searched(
      { ...glancing, "plans/tasks.md": about },
      "idle release claim",
    );
    expect(names(page)[0]).toBe("plans/tasks.md");
    // its best lines hold all three words, not the title and summary
    expect(page.files[0]!.lines.map((line) => line.line)).toEqual([3, 4, 5]);
  });
});

describe("knowledge search credit", () => {
  test("inner matches list below every credited file", () => {
    const page = searched(
      {
        "a.md": "the claimUploads port\n",
        "b.md": "reclaim it\n",
        "c.md": "two claims\n",
        "d.md": "a claim\n",
      },
      "claim",
    );
    expect(names(page)).toEqual(["d.md", "c.md", "a.md", "b.md"]);
  });

  test("separators and plain endings credit a match", () => {
    const page = searched(
      {
        "a.md": "the prerelease build\n",
        "b.md": "the pre-release build\n",
        "c.md": "see release-notes\n",
        "d.md": "while releasing it, a release\n",
        "e.md": "unrelease\n",
      },
      "release",
    );
    expect(names(page).slice(-2)).toEqual(["a.md", "e.md"]);
    expect(names(page)[0]).toBe("d.md");
  });

  test("a Han term is credited inside Chinese text", () => {
    const page = searched(
      {
        "a.md": "我们的搜索功能很好用，也很快\n",
        "b.md": "我们的搜索功能很好用，搜索很快\n",
      },
      "搜索",
    );
    expect(names(page)).toEqual(["b.md", "a.md"]);
  });
});

describe("knowledge search paging", () => {
  test("every text match shows once across pages, names on the first", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3 * SEARCH_PAGE + 4; i++) {
      // counts 1 to 5 repeat, so many files tie
      const uses = (i % 5) + 1;
      files[`f/${String(i).padStart(2, "0")}.md`] =
        `${Array.from({ length: uses }, () => "topic").join(" ")}\n`;
    }
    for (let i = 0; i < 4; i++) files[`topic-${i}.md`] = "none\n";
    files["other.md"] = "nothing\n";
    const s = project(files);
    try {
      const seen: string[] = [];
      const pages = [];
      let after: string | null = null;
      for (let i = 0; i < 10; i++) {
        const page = s.area.search(s.projectId, "u", "topic", after);
        pages.push(page);
        seen.push(...names(page));
        after = page.next;
        if (after === null) break;
      }
      expect(after).toBeNull();
      expect(pages).toHaveLength(4);
      expect(pages[0]!.names.map((file) => file.name)).toEqual([
        "topic-0.md",
        "topic-1.md",
        "topic-2.md",
        "topic-3.md",
      ]);
      expect(pages.slice(1).every((page) => page.names.length === 0)).toBe(
        true,
      );
      const matches = Object.keys(files).filter((name) =>
        name.startsWith("f/"),
      );
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual(matches.sort());
      // more uses first, then name order
      const uses = (name: string) => files[name]!.split("topic").length - 1;
      const expected = [...matches].sort(
        (a, b) => uses(b) - uses(a) || (a < b ? -1 : 1),
      );
      expect(seen).toEqual(expected);
    } finally {
      s.db.close();
    }
  });
});
