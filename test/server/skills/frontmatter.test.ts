// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillMd } from "../../../src/server/skills/frontmatter.ts";

const fixture = (name: string) =>
  readFileSync(
    join(import.meta.dir, "..", "..", "fixtures", "skills", name),
    "utf8",
  );

describe("parseSkillMd", () => {
  test("reads the two recorded verification skills", () => {
    const gitops = parseSkillMd(fixture("gitops-knowledge.SKILL.md"));
    expect(gitops.name).toBe("gitops-knowledge");
    expect(gitops.description).toStartWith("Flux CD and Flux Operator expert");
    expect(gitops.description).not.toContain("\n");
    const timoni = parseSkillMd(fixture("timoni.SKILL.md"));
    expect(timoni.metadata).toEqual({
      author: "Stefan Prodan",
      homepage: "https://timoni.sh",
      source: "https://github.com/stefanprodan/timoni",
      version: "0.3.0",
    });
  });

  test("reads quoted, colon, folded, literal and ignored extension values", () => {
    const parsed = parseSkillMd(`---
name: safe-skill
description: >-
  one line
  with a colon: yes
license: "Apache: 2"
compatibility: works: here
metadata:
  version: '1.0'
unknown:
  - one
  - two
allowed-tools: read only
---
body`);
    expect(parsed.description).toBe("one line with a colon: yes");
    expect(parsed.license).toBe("Apache: 2");
    expect(parsed.compatibility).toBe("works: here");
    expect(parsed.metadata).toEqual({ version: "1.0" });
    expect(parsed.body).toBe("body");
    expect(
      parseSkillMd("---\nname: x\ndescription: |+\n  first\n  second\n---\nb")
        .description,
    ).toBe("first second");
  });

  test("cuts every bounded field instead of refusing it", () => {
    const metadata = Array.from(
      { length: 40 },
      (_, i) => `  key${i}: ${"v".repeat(300)}`,
    ).join("\n");
    const parsed = parseSkillMd(
      `---\nname: x\ndescription: ${"d".repeat(1200)}\nlicense: ${"l".repeat(300)}\ncompatibility: ${"c".repeat(600)}\nmetadata:\n${metadata}\nallowed-tools: ${"t".repeat(1200)}\n---\nx`,
    );
    expect(parsed.description).toHaveLength(1024);
    expect(parsed.license).toHaveLength(256);
    expect(parsed.compatibility).toHaveLength(500);
    expect(Object.keys(parsed.metadata)).toHaveLength(32);
    expect(parsed.metadata.key0).toHaveLength(256);
    expect(parsed.allowedTools).toHaveLength(1024);
  });

  test("reads a leading UTF-8 BOM leniently", () => {
    const parsed = parseSkillMd(
      "\uFEFF---\nname: ops\ndescription: ops here\n---\nbody",
    );
    expect(parsed.name).toBe("ops");
    expect(parsed.description).toBe("ops here");
    expect(parsed.body).toBe("body");
  });

  test.each([
    ["body", "no frontmatter"],
    ["---\nname: x", "not closed"],
    ["---\nname: x\n---\nbody", "no description"],
    ["---\nname: Upper\ndescription: x\n---\n", "invalid name"],
    ["---\nname: bad--name\ndescription: x\n---\n", "invalid name"],
    [`---\nname: ${"a".repeat(65)}\ndescription: x\n---\n`, "invalid name"],
  ])("refuses invalid frontmatter %#", (text, words) => {
    expect(() => parseSkillMd(text)).toThrow(words);
  });
});
