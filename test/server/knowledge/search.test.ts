// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { parseSearch } from "../../../src/server/knowledge/parse.ts";
import {
  matchText,
  oneAtATime,
  type SearchSource,
  search,
} from "../../../src/server/knowledge/search.ts";
import { BadRequest, HttpError } from "../../../src/server/lib/errors.ts";
import {
  SEARCH_LINE_CHARS,
  SEARCH_NAMES,
  SEARCH_PAGE,
} from "../../../src/shared/api/knowledge.ts";
import { type Setup, setup } from "./helpers.ts";

// the store's rows, counting the text bytes it loads
function source(s: Setup) {
  const loaded = { bytes: 0, files: [] as string[] };
  const store = s.area.store;
  const counted: SearchSource = {
    files: (after) => store.after(s.projectId, after),
    named: (after, query) => store.named(s.projectId, after, query),
    text(fileId) {
      const text = store.text(s.projectId, fileId);
      loaded.bytes += Buffer.byteLength(text);
      loaded.files.push(store.byId(s.projectId, fileId)!.name);
      return text;
    },
  };
  return Object.assign(counted, { loaded });
}

const url = (query: string) =>
  new URL(`http://x/api/projects/p/knowledge/search?${query}`);

describe("knowledge search", () => {
  test("counts matching lines in any case and keeps the first three", () => {
    const text = "Alpha\nbeta\nALPHA two\ngamma\nalphabet\nlast alpha";
    expect(matchText(text, "alpha")).toEqual({
      count: 4,
      lines: [
        { line: 1, text: "Alpha", cutStart: false, cutEnd: false },
        { line: 3, text: "ALPHA two", cutStart: false, cutEnd: false },
        { line: 5, text: "alphabet", cutStart: false, cutEnd: false },
      ],
    });
    expect(matchText(text, "delta")).toBeNull();
  });

  test("drops a carriage return and never matches across lines", () => {
    expect(matchText("one two\r\nthree", "two")?.lines).toEqual([
      { line: 1, text: "one two", cutStart: false, cutEnd: false },
    ]);
    expect(matchText("one\ntwo", "one\ntwo")).toBeNull();
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

  test("pages the files whose text holds the query in name order", () => {
    const s = setup();
    try {
      for (let i = 1; i <= SEARCH_PAGE + 2; i++) {
        const name = `notes/n${String(i).padStart(2, "0")}.md`;
        s.area.create(s.projectId, s.author, name, `line\nsome Topic ${i}\n`);
      }
      s.area.create(s.projectId, s.author, "other.md", "nothing here\n");
      const first = s.area.search(s.projectId, "u", "topic", null);
      expect(first.files.map((hit) => hit.file.name)).toEqual(
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
      expect(first.next).toBe(`notes/n${SEARCH_PAGE}.md`);
      const second = s.area.search(s.projectId, "u", "topic", first.next);
      expect(second.files.map((hit) => hit.file.name)).toEqual([
        "notes/n11.md",
        "notes/n12.md",
      ]);
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
      s.area.create(s.projectId, s.author, "zeta.md", "the TOPIC\n");
      const first = s.area.search(s.projectId, "u", "TOPIC", null);
      expect(first.names.map((file) => file.name)).toEqual(["plans/Topic.md"]);
      expect(first.namesTotal).toBe(1);
      expect(first.files.map((hit) => hit.file.name)).toEqual([
        "topics/both.md",
        "zeta.md",
      ]);
      const later = s.area.search(s.projectId, "u", "topic", "topics/both.md");
      expect(later.names).toEqual([]);
      expect(later.namesTotal).toBe(0);
      expect(later.files.map((hit) => hit.file.name)).toEqual(["zeta.md"]);
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

  test("parses q and after", () => {
    expect(parseSearch(url("q=%20ab%20"))).toEqual({ q: "ab", after: null });
    expect(parseSearch(url("q=abc&after=docs/x.md"))).toEqual({
      q: "abc",
      after: "docs/x.md",
    });
  });

  test.each([
    ["", "q must appear once"],
    ["q=a&q=b", "q must appear once"],
    ["q=a", "q must be 2 to 100 characters"],
    ["q=%20a%20", "q must be 2 to 100 characters"],
    [`q=${"x".repeat(101)}`, "q must be 2 to 100 characters"],
    ["q=a%0Ab", "q must be one line of text"],
    ["q=ab&after=x&after=y", "after must appear once"],
    ["q=ab&after=../x", "after must be a file name"],
    ["q=ab&after=", "after must be a file name"],
    ["q=ab&page=2", "unknown parameter page"],
  ])("refuses %j", (query, words) => {
    expect(() => parseSearch(url(query))).toThrow(new BadRequest(words));
  });
  test("a spent budget ends the page early with next set", () => {
    const s = setup();
    try {
      for (const name of ["a.md", "b.md", "c.md", "d.md"]) {
        s.area.create(s.projectId, s.author, name, "0123456789 hit\n");
      }
      const page = search(source(s), "hit", null, 30);
      expect(page.files.map((hit) => hit.file.name)).toEqual(["a.md", "b.md"]);
      expect(page.next).toBe("b.md");
      const rest = search(source(s), "hit", page.next, 30);
      expect(rest.files.map((hit) => hit.file.name)).toEqual(["c.md", "d.md"]);
      expect(rest.next).toBeNull();
      // one file a page at least, however small the budget
      expect(search(source(s), "hit", null, 0).files).toHaveLength(1);
    } finally {
      s.db.close();
    }
  });

  test("names past a spent budget are listed on the name alone", () => {
    const s = setup();
    try {
      s.area.create(s.projectId, s.author, "a.md", "0123456789 hit\n");
      s.area.create(s.projectId, s.author, "b.md", "0123456789 hit\n");
      s.area.create(s.projectId, s.author, "hit-1.md", "none\n");
      s.area.create(s.projectId, s.author, "hit-2.md", "a hit\n");
      const page = search(source(s), "hit", null, 30);
      expect(page.files.map((hit) => hit.file.name)).toEqual(["a.md", "b.md"]);
      expect(page.next).toBe("b.md");
      // unread, hit-2.md is named here and found in its text on a later page
      expect(page.names.map((file) => file.name)).toEqual([
        "hit-1.md",
        "hit-2.md",
      ]);
      const judged = search(source(s), "hit", null, 1000);
      expect(judged.names.map((file) => file.name)).toEqual(["hit-1.md"]);
    } finally {
      s.db.close();
    }
  });
  test("never loads text past the budget, the page and the names together", () => {
    const s = setup();
    try {
      // 15 bytes each
      s.area.create(s.projectId, s.author, "a.md", "0123456789 hit\n");
      s.area.create(s.projectId, s.author, "b.md", "0123456789 hit\n");
      s.area.create(s.projectId, s.author, "c.md", "0123456789 hit\n");
      s.area.create(s.projectId, s.author, "hit-1.md", "none, 15 bytes\n");
      s.area.create(s.projectId, s.author, "hit-2.md", "none, 15 bytes\n");
      for (const budget of [0, 14, 15, 29, 30, 44, 45, 60, 75]) {
        const counted = source(s);
        const page = search(counted, "hit", null, budget);
        expect(counted.loaded.bytes).toBeLessThanOrEqual(Math.max(15, budget));
        expect(page.namesTotal).toBe(2);
      }
      const counted = source(s);
      const page = search(counted, "hit", null, 50);
      expect(counted.loaded.files).toEqual(["a.md", "b.md", "c.md"]);
      expect(page.next).toBe("c.md");
      const names = source(s);
      search(names, "hit", null, 45);
      // the names pass starts where the page stopped and is held too
      expect(names.loaded.files).toEqual(["a.md", "b.md", "c.md"]);
      const all = source(s);
      expect(search(all, "hit", null, 75).next).toBeNull();
      expect(all.loaded.bytes).toBe(75);
    } finally {
      s.db.close();
    }
  });

  test("the names pass reads only named files within what is left", () => {
    const s = setup();
    try {
      for (let i = 0; i < SEARCH_PAGE + 1; i++) {
        s.area.create(s.projectId, s.author, `a${i}.md`, "x hit\n");
      }
      s.area.create(s.projectId, s.author, "b.md", "no match\n");
      s.area.create(s.projectId, s.author, "hit-1.md", "none\n");
      s.area.create(s.projectId, s.author, "hit-2.md", "hit\n");
      const counted = source(s);
      const page = search(counted, "hit", null, 11 * 6 + 5);
      expect(page.files).toHaveLength(SEARCH_PAGE);
      expect(counted.loaded.files.slice(SEARCH_PAGE + 1)).toEqual(["hit-1.md"]);
      expect(counted.loaded.bytes).toBeLessThanOrEqual(11 * 6 + 5);
      expect(page.names.map((file) => file.name)).toEqual([
        "hit-1.md",
        "hit-2.md",
      ]);
    } finally {
      s.db.close();
    }
  });
});
