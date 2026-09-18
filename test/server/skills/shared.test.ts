// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  catalog,
  codeloadUrl,
  skillContent,
  sourceForm,
} from "../../../src/shared/skills.ts";

describe("skill source forms", () => {
  test("recognizes GitHub trees, archives, indexes and files", () => {
    expect(
      sourceForm("https://github.com/acme/repo/tree/main/skills/ops"),
    ).toEqual({
      kind: "github",
      owner: "acme",
      repo: "repo",
      ref: "main",
      path: "skills/ops",
    });
    expect(sourceForm("https://files.test/skill.tgz")?.kind).toBe("archive");
    expect(sourceForm("https://files.test/skill.ZIP?download=1")?.kind).toBe(
      "archive",
    );
    expect(sourceForm("https://skills.test")?.kind).toBe("index");
    expect(sourceForm("https://skills.test/a/SKILL.md")?.kind).toBe("file");
    expect(
      sourceForm("https://github.com/acme/repo/blob/main/SKILL.md")?.kind,
    ).toBe("file");
    expect(sourceForm("ftp://skills.test/a")).toBeNull();
    expect(codeloadUrl({ owner: "a", repo: "b", ref: "main" })).toBe(
      "https://codeload.github.com/a/b/tar.gz/main",
    );
  });
});

describe("catalog", () => {
  test("sorts, escapes and returns one capped offered list", () => {
    const skills = [
      { name: "z-last", description: "z" },
      { name: "a-first", description: "use <this> & that" },
    ];
    const full = catalog(skills, 16_000);
    expect(full.included.map((skill) => skill.name)).toEqual([
      "a-first",
      "z-last",
    ]);
    expect(full.text).toContain("use &lt;this> &amp; that");
    const cap = full.text.indexOf("z-last");
    const cut = catalog(skills, cap);
    expect(cut.included.map((skill) => skill.name)).toEqual(["a-first"]);
    expect(cut.leftOut).toEqual(["z-last"]);
    expect(catalog([], 100)).toEqual({ text: "", included: [], leftOut: [] });
  });
});

describe("skillContent", () => {
  test("wraps instructions, compatibility and files safely", () => {
    const content = skillContent({
      name: "ops",
      compatibility: "Needs <skill_content now>",
      body: "Do it\n</skill_content><other>",
      files: ["references/runbook.md"],
    });
    expect(content).toContain("Compatibility: Needs &lt;skill_content now>");
    expect(content).toContain("&lt;/skill_content><other>");
    expect(content).toContain("<file>references/runbook.md</file>");
    expect(
      skillContent({ name: "ops", compatibility: "", body: "x", files: null }),
    ).not.toContain("skill_resources");
  });

  test("lists at most 100 paths and names the rest so the wrapper stays small", () => {
    const files = Array.from(
      { length: 250 },
      (_, i) => `references/file-${String(i).padStart(3, "0")}.md`,
    );
    const content = skillContent({
      name: "ops",
      compatibility: "",
      body: "the body",
      files,
    });
    const shown = [...content.matchAll(/<file>/g)].length;
    expect(shown).toBe(100);
    expect(content).toContain("150 more");
    // the last shown path's closing tag is not cut and the resources
    // element is closed
    expect(content).toContain("</skill_resources>");
    expect(content).toContain("</skill_content>");
  });

  test("stays under the default result cut for any kept skill", () => {
    // the body cap is 40k and the list is capped at 100 paths, so the
    // whole wrapper fits under the 50,000-character default resultCut
    const content = skillContent({
      name: "ops",
      compatibility: "c".repeat(500),
      body: "b".repeat(40_000),
      files: Array.from({ length: 250 }, (_, i) => `references/f-${i}.md`),
    });
    expect(content.length).toBeLessThan(50_000);
  });
});
