// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// vendor/changes.md against the (1ctx <id>) markers in the vendored source
// and scripts/, so a sync can find every hunk of a change by its id.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CHANGES = join(ROOT, "vendor", "changes.md");
const SOURCES = [
  join(ROOT, "vendor", "just-bash", "src"),
  join(ROOT, "scripts"),
];
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UPSTREAM =
  /^(not reported|issue #\d+|PR #\d+|ported from #\d+|fixed in \d+\.\d+\.\d+)$/;
const MARKER = /\(1ctx(?=[ )])([^)]*)\)/g;

interface Entry {
  id: string;
  line: number;
  fields: [string, string][];
  body: string[];
}

function parseEntries(text: string): Entry[] {
  const entries: Entry[] = [];
  let entry: Entry | null = null;
  let inFields = false;
  text.split("\n").forEach((line, i) => {
    if (line.startsWith("#")) {
      entry = null;
      const heading = /^### ([^:]+): \S/.exec(line);
      if (!line.startsWith("### ")) return;
      entry = {
        id: heading ? heading[1] : line.slice(4),
        line: i + 1,
        fields: [],
        body: [],
      };
      entries.push(entry);
      inFields = true;
      return;
    }
    if (!entry) return;
    if (inFields && line === "") inFields = false;
    else if (inFields && line.startsWith("  ") && entry.fields.length > 0)
      entry.fields[entry.fields.length - 1][1] += ` ${line.trim()}`;
    else if (inFields) {
      const field = /^([A-Za-z]+): (.*)$/.exec(line);
      entry.fields.push(field ? [field[1], field[2]] : ["", line]);
    } else if (line !== "") entry.body.push(line);
  });
  return entries;
}

function paths(value: string): string[] {
  return [...value.matchAll(/`([^`]+)`/g)].map(([, span]) => span);
}

// Files are under the vendored package, but our own scripts/.
function filesPath(path: string): string {
  return path.startsWith("scripts/")
    ? join(ROOT, path)
    : join(ROOT, "vendor", "just-bash", path);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|js|sh)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function markers(): { file: string; ids: string[] }[] {
  const found: { file: string; ids: string[] }[] = [];
  for (const dir of SOURCES)
    for (const path of sourceFiles(dir)) {
      const text = readFileSync(path, "utf8");
      if (!text.includes("(1ctx")) continue;
      text.split("\n").forEach((line, i) => {
        for (const [, ids] of line.matchAll(MARKER))
          found.push({
            file: `${relative(ROOT, path)}:${i + 1}`,
            ids: ids.trim() === "" ? [] : ids.trim().split(/\s+/),
          });
      });
    }
  return found;
}

const entries = parseEntries(readFileSync(CHANGES, "utf8"));
const found = markers();

describe("the record of our just-bash changes", () => {
  test("every entry is written in the format", () => {
    const problems: string[] = [];
    for (const e of entries) {
      const at = `${e.id} (changes.md:${e.line})`;
      if (!ID.test(e.id)) problems.push(`${at}: the id is not kebab-case`);
      const names = e.fields.map(([name]) => name).join(",");
      if (
        names !== "Files,Upstream,Tests" &&
        names !== "Files,Upstream,Tests,Markers"
      )
        problems.push(`${at}: fields ${names}, not Files, Upstream, Tests`);
      const field = (name: string) =>
        e.fields.find(([n]) => n === name)?.[1] ?? "";
      if (!UPSTREAM.test(field("Upstream")))
        problems.push(`${at}: Upstream is "${field("Upstream")}"`);
      const markersField = field("Markers");
      if (names.endsWith("Markers") && !/^none, \S/.test(markersField))
        problems.push(`${at}: Markers is not "none, <reason>"`);
      const tests = field("Tests");
      if (tests.startsWith("none")) {
        if (!/^none, \S/.test(tests))
          problems.push(`${at}: Tests is none without a reason`);
      } else if (paths(tests).length === 0)
        problems.push(`${at}: Tests names no file`);
      if (paths(field("Files")).length === 0)
        problems.push(`${at}: Files names no file`);
      // a merged change lists its parts under a bare Now: and Before:
      const now = e.body.findIndex((l) => /^Now:( |$)/.test(l));
      const before = e.body.findIndex((l) => /^Before:( |$)/.test(l));
      if (now !== 0 || before <= now)
        problems.push(`${at}: the body is not Now, then Before`);
    }
    expect(problems).toEqual([]);
  });

  test("the ids are unique", () => {
    const seen = new Set<string>();
    const twice = entries
      .map((e) => e.id)
      .filter((id) => seen.has(id) || !seen.add(id));
    expect(twice).toEqual([]);
  });

  test("every Tests path exists", () => {
    const missing: string[] = [];
    for (const e of entries) {
      const tests = e.fields.find(([n]) => n === "Tests")?.[1] ?? "";
      if (tests.startsWith("none")) continue;
      for (const path of paths(tests))
        if (!existsSync(join(ROOT, path))) missing.push(`${e.id}: ${path}`);
    }
    expect(missing).toEqual([]);
  });

  test("every Files path exists", () => {
    const missing: string[] = [];
    for (const e of entries) {
      const files = e.fields.find(([n]) => n === "Files")?.[1] ?? "";
      for (const path of paths(files))
        if (!existsSync(filesPath(path))) missing.push(`${e.id}: ${path}`);
    }
    expect(missing).toEqual([]);
  });

  test("no marker is bare", () => {
    expect(found.filter((m) => m.ids.length === 0).map((m) => m.file)).toEqual(
      [],
    );
  });

  test("every id a marker names has an entry", () => {
    const ids = new Set(entries.map((e) => e.id));
    const unknown = found.flatMap((m) =>
      m.ids.filter((id) => !ids.has(id)).map((id) => `${id} at ${m.file}`),
    );
    expect(unknown).toEqual([]);
  });

  test("no marker names an id twice", () => {
    const twice = found
      .filter((m) => new Set(m.ids).size !== m.ids.length)
      .map((m) => m.file);
    expect(twice).toEqual([]);
  });

  test("every marker sits in a file its entry lists", () => {
    const files = new Map(
      entries.map((e) => [
        e.id,
        new Set(paths(e.fields.find(([n]) => n === "Files")?.[1] ?? "")),
      ]),
    );
    const outside: string[] = [];
    for (const m of found) {
      // the path as Files writes it: from the package, or scripts/
      const path = m.file
        .slice(0, m.file.lastIndexOf(":"))
        .replace(/^vendor\/just-bash\//, "");
      for (const id of new Set(m.ids)) {
        const listed = files.get(id);
        if (listed && !listed.has(path)) outside.push(`${id}: ${m.file}`);
      }
    }
    expect([...new Set(outside)]).toEqual([]);
  });

  test("every entry has a marker, or says it has none", () => {
    const marked = new Set(found.flatMap((m) => m.ids));
    const problems: string[] = [];
    for (const e of entries) {
      const none = e.fields.some(([n]) => n === "Markers");
      if (!none && !marked.has(e.id))
        problems.push(`${e.id}: no marker names it`);
      if (none && marked.has(e.id))
        problems.push(`${e.id}: says Markers none, but a marker names it`);
    }
    expect(problems).toEqual([]);
  });
});
