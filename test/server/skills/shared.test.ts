// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  CATALOG_LEAD,
  type CatalogSkill,
  catalog,
  SKILL_CATALOG_OPENINGS,
  skillContent,
  sourceForm,
} from "../../../src/shared/skills.ts";
import { MAX_CATALOG_LINE } from "../../../src/shared/text.ts";

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
    expect(sourceForm("https://files.test/skill.tar.gz")?.kind).toBe("archive");
    expect(sourceForm("https://files.test/skill.zip")?.kind).toBe("archive");
    expect(sourceForm("https://files.test/skill.ZIP?download=1")?.kind).toBe(
      "archive",
    );
    expect(sourceForm("https://skills.test")?.kind).toBe("index");
    expect(sourceForm("https://skills.test/.well-known/index.json")?.kind).toBe(
      "index",
    );
    expect(sourceForm("https://skills.test/a/SKILL.md")?.kind).toBe("file");
    expect(
      sourceForm("https://github.com/acme/repo/blob/main/SKILL.md")?.kind,
    ).toBe("file");
    expect(sourceForm("ftp://skills.test/a")).toBeNull();
    expect(sourceForm("not a url")).toBeNull();
  });
});

// the block as the format says, built here by hand, so an exact length
// proves the fit counts the lead, the opening line and the closing tag
function tierText(tier: 0 | 1 | 2, skills: CatalogSkill[]): string {
  const lead =
    tier === 2
      ? CATALOG_LEAD.replace("skill's description", "skill's name")
      : CATALOG_LEAD;
  const body = skills
    .map((skill) => {
      const about =
        tier === 2
          ? ""
          : `    <description>${
              tier === 0 ? skill.description : skill.description.split(" ")[0]
            }</description>\n`;
      return `  <skill>\n    <name>${skill.name}</name>\n${about}  </skill>\n`;
    })
    .join("");
  return `${lead}\n${SKILL_CATALOG_OPENINGS[tier]}\n\n<available_skills>\n${body}</available_skills>`;
}

// every description's first sentence is its first word
const described = (count: number): CatalogSkill[] =>
  Array.from({ length: count }, (_, i) => ({
    name: `skill-${String(i).padStart(3, "0")}`,
    description: `Does. ${"more ".repeat(40)}`.trim(),
  }));

describe("catalog", () => {
  test("sorts and escapes every skill", () => {
    const skills = [
      { name: "z-last", description: "z" },
      { name: "a-first", description: "use <this> & that" },
    ];
    const full = catalog(skills, 16_000);
    expect(full.overCap).toBe(false);
    expect(full.text.indexOf("a-first")).toBeLessThan(
      full.text.indexOf("z-last"),
    );
    expect(full.text).toContain("use &lt;this> &amp; that");
    expect(full.text).toContain(
      `${CATALOG_LEAD}\n${SKILL_CATALOG_OPENINGS[0]}\n\n<available_skills>\n`,
    );
    expect(catalog([], 100)).toEqual({ text: "", overCap: false });
  });

  test("the first tier whose whole text fits is picked, at its boundary", () => {
    const skills = described(3);
    for (const tier of [0, 1, 2] as const) {
      const text = tierText(tier, skills);
      // exactly at the cap the tier fits, one under it the next is tried
      expect(catalog(skills, text.length)).toEqual({ text, overCap: false });
      if (tier < 2) {
        expect(catalog(skills, text.length - 1).text).toBe(
          tierText((tier + 1) as 1 | 2, skills),
        );
      }
    }
    expect(tierText(2, skills)).toContain("matches a skill's name");
    expect(tierText(2, skills)).not.toContain("<description>");
  });

  test("the second tier cuts a long first sentence at the line cap", () => {
    const long = [{ name: "long", description: `${"w".repeat(400)}. More.` }];
    const text = catalog(long, tierText(0, long).length - 1).text;
    expect(text).toContain(SKILL_CATALOG_OPENINGS[1]);
    expect(text).toContain(
      `<description>${"w".repeat(MAX_CATALOG_LINE - 1)}…</description>`,
    );
  });

  test("tier 3 is the floor, printed over the cap with nothing dropped", () => {
    const skills = described(3);
    const floor = tierText(2, skills);
    expect(catalog(skills, floor.length - 1)).toEqual({
      text: floor,
      overCap: true,
    });
    for (const skill of skills) expect(floor).toContain(skill.name);
  });

  test("the block is byte-stable for one snapshot", () => {
    const skills = described(5).reverse();
    for (const cap of [100, 1_000, 16_000]) {
      expect(catalog(skills, cap)).toEqual(
        catalog(structuredClone(skills), cap),
      );
    }
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
