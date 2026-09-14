// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// changeOf compares two loaded skills and answers what a refresh moved,
// computed from the digests, or null when a refresh found nothing new.
// A dropped list that moved is one of the changes it names, under the
// field "dropped" (decision 7), so a refresh that only stopped keeping
// a file still records a change the page can show.

import { describe, expect, test } from "bun:test";
import { changeOf, type LoadedSkill } from "../../../src/server/skills/load.ts";

const base = (over: Partial<LoadedSkill> = {}): LoadedSkill => ({
  name: "ops",
  description: "ops instructions",
  body: "body",
  license: "",
  compatibility: "",
  metadata: {},
  allowedTools: "",
  sourceKind: "file",
  sourceUrl: "https://skills.test/ops.md",
  sourceSelect: "",
  sourceDigest: "",
  digest: "ops-digest",
  dropped: [],
  droppedMore: 0,
  files: [],
  ...over,
});

describe("changeOf", () => {
  test("answers null when nothing the digest sees moved", () => {
    expect(changeOf(base(), base(), 100)).toBeNull();
  });

  test("names the complete dropped-only state under the dropped field", () => {
    const before = base();
    const after = base({
      dropped: [{ path: "assets/logo.png", reason: "binary" }],
      droppedMore: 2,
    });
    const change = changeOf(before, after, 200);
    expect(change).not.toBeNull();
    expect(change?.fields).toContain("dropped");
    // nothing else moved: the body, the description and the files held
    expect(change?.body).toBeFalse();
    expect(change?.description).toBeFalse();
    expect(change?.files).toEqual({ added: [], removed: [], changed: [] });
    expect(change?.at).toBe(200);
  });

  test("sees dropped overflow but ignores metadata insertion order", () => {
    const dropped = [{ path: "assets/logo.png", reason: "binary" }];
    expect(
      changeOf(
        base({ dropped, droppedMore: 1 }),
        base({ dropped, droppedMore: 2 }),
        250,
      )?.fields,
    ).toContain("dropped");
    expect(
      changeOf(
        base({ metadata: { author: "a", version: "1" } }),
        base({ metadata: { version: "1", author: "a" } }),
        250,
      ),
    ).toBeNull();
  });

  test("names the frontmatter fields, the body and the files that moved", () => {
    const before = base({
      files: [{ path: "a.md", content: "one", bytes: 3 }],
    });
    const after = base({
      body: "new body",
      description: "new description",
      license: "Apache-2.0",
      metadata: { version: "2" },
      files: [
        { path: "a.md", content: "two", bytes: 3 },
        { path: "b.md", content: "add", bytes: 3 },
      ],
    });
    const change = changeOf(before, after, 300);
    expect(change?.body).toBeTrue();
    expect(change?.description).toBeTrue();
    expect(change?.fields).toEqual(
      expect.arrayContaining(["license", "metadata"]),
    );
    expect(change?.files).toEqual({
      added: ["b.md"],
      removed: [],
      changed: ["a.md"],
    });
  });
});
