// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseIndex,
  pick,
  resolve,
} from "../../../src/server/skills/source.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const fixture = (name: string) =>
  readFileSync(
    join(import.meta.dir, "..", "..", "fixtures", "skills", name),
    "utf8",
  );

describe("resolve", () => {
  test("resolves all four source forms", () => {
    expect(resolve("https://github.com/acme/repo/tree/main/skills/x")).toEqual({
      kind: "github",
      sourceUrl: "https://github.com/acme/repo/tree/main/skills/x",
      fetchUrl: "https://codeload.github.com/acme/repo/tar.gz/main",
      select: "skills/x",
    });
    expect(resolve("https://files.test/x.tar.gz", "inside").kind).toBe(
      "archive",
    );
    expect(resolve("https://skills.test").fetchUrl).toBe(
      "https://skills.test/.well-known/agent-skills/index.json",
    );
    expect(resolve("https://skills.test/path").kind).toBe("file");
  });
});

describe("parseIndex", () => {
  test("reads recorded relative and absolute entries", () => {
    const timoni = parseIndex(
      fixture("timoni.index.json"),
      "https://skills.test/index.json",
    );
    expect(timoni[0]?.url).toBe(
      "https://skills.test/.well-known/agent-skills/timoni/skill.md",
    );
    const supabase = parseIndex(
      fixture("supabase.index.json"),
      "https://skills.test/index.json",
    );
    expect(supabase).toHaveLength(2);
    expect(supabase[0]?.type).toBe("archive");
  });

  test("refuses malformed and unbounded entries", () => {
    expect(() => parseIndex("no", "https://x.test/index.json")).toThrow(
      "not JSON",
    );
    expect(() =>
      parseIndex(
        JSON.stringify({ skills: [{ name: "BAD" }] }),
        "https://x.test/index.json",
      ),
    ).toThrow("invalid name");
    const entry = {
      name: "x",
      type: "skill-md",
      description: "x",
      url: "/x",
      digest: `sha256:${"a".repeat(64)}`,
    };
    expect(() =>
      parseIndex(
        JSON.stringify({ skills: Array(201).fill(entry) }),
        "https://x.test/index.json",
      ),
    ).toThrow("too many");
    expect(() =>
      parseIndex(
        JSON.stringify({ skills: [{ ...entry, digest: "" }] }),
        "https://x.test/index.json",
      ),
    ).toThrow("invalid digest");
  });
});

describe("pick", () => {
  test("selects a codeload directory and returns relative files", () => {
    const selected = pick(
      new Map([
        ["repo-main/skills/x/SKILL.md", bytes("skill")],
        ["repo-main/skills/x/references/a.md", bytes("a")],
        ["repo-main/other.txt", bytes("other")],
      ]),
      "skills/x",
    );
    expect([...selected.files.keys()]).toEqual(["references/a.md"]);
  });

  test("finds one root skill and refuses ambiguity, absence and bad paths", () => {
    expect(pick(new Map([["SKILL.md", bytes("x")]]), "").skillMd).toEqual(
      bytes("x"),
    );
    expect(() =>
      pick(
        new Map([
          ["a/SKILL.md", bytes("a")],
          ["b/SKILL.md", bytes("b")],
        ]),
        "",
      ),
    ).toThrow("more than one");
    expect(() => pick(new Map([["x.txt", bytes("x")]]), "")).toThrow(
      "no SKILL.md",
    );
    expect(() => pick(new Map([["../SKILL.md", bytes("x")]]), "")).toThrow(
      "invalid archive path",
    );
    for (const path of ["/SKILL.md", "a//SKILL.md"]) {
      expect(() => pick(new Map([[path, bytes("x")]]), "")).toThrow(
        "invalid archive path",
      );
    }
  });

  test("reads a leading ./ path leniently as its normalized form", () => {
    const selected = pick(
      new Map([
        ["./SKILL.md", bytes("x")],
        ["./references/a.md", bytes("a")],
      ]),
      "",
    );
    expect(selected.skillMd).toEqual(bytes("x"));
    expect([...selected.files.keys()]).toEqual(["references/a.md"]);
  });
});
