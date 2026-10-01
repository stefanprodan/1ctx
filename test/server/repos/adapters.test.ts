// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  adapter,
  checkRef,
  covers,
  defaultName,
  isCommit,
  normalizeUrl,
} from "../../../src/server/repos/index.ts";

const normal = (value: string) => {
  const result = normalizeUrl(value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const refusal = (value: unknown) => {
  const result = normalizeUrl(value);
  if (result.ok) throw new Error(`took ${String(value)}`);
  return result.error;
};

describe("a repository URL", () => {
  test.each([
    ["https://github.com/acme/widgets", "https://github.com/acme/widgets"],
    ["https://GitHub.com/acme/widgets.git", "https://github.com/acme/widgets"],
    ["https://github.com/acme/widgets/", "https://github.com/acme/widgets"],
    [
      "https://github.com:443/acme/widgets.git/",
      "https://github.com/acme/widgets",
    ],
    ["https://github.com./acme/widgets", "https://github.com/acme/widgets"],
    [
      "  https://gitlab.com/acme/tools/cli  ",
      "https://gitlab.com/acme/tools/cli",
    ],
    [
      "https://git.example.test:8443/a/b.git",
      "https://git.example.test:8443/a/b",
    ],
  ])("%s is %s", (input, url) => {
    expect(normal(input).url).toBe(url);
  });

  test("a public host fixes the kind, any other leaves it to the row", () => {
    expect(normal("https://github.com/acme/widgets").kind).toBe("github");
    expect(normal("https://gitlab.com/acme/widgets").kind).toBe("gitlab");
    expect(normal("https://git.example.test/acme/widgets").kind).toBeNull();
    expect(normal("https://gitlab.com/acme/sub/widgets").segments).toEqual([
      "acme",
      "sub",
      "widgets",
    ]);
  });

  test.each([
    [42, "url must be a URL"],
    ["", "url must be a URL"],
    ["github.com/acme/widgets", "url must be a URL"],
    ["http://github.com/acme/widgets", "https"],
    ["https://casey:pw@github.com/acme/widgets", "user or a password"],
    ["https://github.com/acme/widgets?tab=readme", "query"],
    ["https://github.com/acme/widgets#readme", "fragment"],
    ["https://github.com/acme/widgets?", "query"],
    ["https://github.com/acme", "must name a repository"],
    ["https://github.com/acme/widgets/tree/main", "github.com/owner/name"],
    ["https://github.com/acme/wid%20gets", "segments of letters"],
    ["https://github.com/acme/wid gets", "segments of letters"],
    ["https://gitlab.com/acme/widgets/-/tree/main", "segments of letters"],
    ["https://github.com/acme/..", "must name a repository"],
    [`https://github.com/acme/${"a".repeat(512)}`, "at most 512"],
  ])("%p is refused: %s", (input, words) => {
    expect(refusal(input)).toContain(words);
  });

  test("the default name is the last segment as isName takes it", () => {
    expect(defaultName(normal("https://github.com/acme/widgets"))).toBe(
      "widgets",
    );
    expect(defaultName(normal("https://github.com/acme/Flux2.git"))).toBe(
      "flux2",
    );
    expect(defaultName(normal("https://github.com/acme/my.repo"))).toBe(
      "my-repo",
    );
    expect(defaultName(normal("https://github.com/acme/_x"))).toBeNull();
  });
});

describe("a ref", () => {
  test.each(["", "main", "v1.2.3", "feature/x-y", "release+1", "3f2a1c9"])(
    "%p is taken",
    (ref) => {
      expect(checkRef(ref)).toEqual({ ok: true, value: ref });
    },
  );

  test.each([
    "-main",
    "/main",
    "main/",
    "a..b",
    "a//b",
    "a b",
    "a~1",
    "a^",
    "a:b",
    "x.lock",
    "x.",
    "a/.hidden",
    "a\\b",
    "a%2Fb",
    "a".repeat(201),
  ])("%p is refused", (ref) => {
    expect(checkRef(ref).ok).toBe(false);
  });

  test("a full commit id needs no lookup", () => {
    expect(isCommit("a".repeat(40))).toBe(true);
    expect(isCommit("0".repeat(64))).toBe(true);
    expect(isCommit("a".repeat(39))).toBe(false);
    expect(isCommit("A".repeat(40))).toBe(false);
    expect(isCommit("main")).toBe(false);
  });
});

describe("the adapters", () => {
  const sha = "8d01e44".padEnd(40, "0");

  test("github.com answers through api.github.com and codeload", () => {
    const a = adapter("https://github.com/acme/widgets", "github");
    expect(a.apiBase).toBe("https://api.github.com/repos/acme/widgets/");
    expect(a.lookupUrl("")).toBe(
      "https://api.github.com/repos/acme/widgets/commits/HEAD",
    );
    expect(a.lookupUrl("feature/x")).toBe(
      "https://api.github.com/repos/acme/widgets/commits/feature/x",
    );
    expect(a.lookupHeaders).toEqual({ accept: "application/vnd.github.sha" });
    expect(a.tarballUrl(sha)).toBe(
      `https://api.github.com/repos/acme/widgets/tarball/${sha}`,
    );
    expect(a.archiveUrl("")).toBe(
      "https://codeload.github.com/acme/widgets/tar.gz/HEAD",
    );
    expect(a.archiveUrl("v1.0.0")).toBe(
      "https://codeload.github.com/acme/widgets/tar.gz/v1.0.0",
    );
    expect(a.page).toBe("https://github.com/acme/widgets");
  });

  test("GitHub Enterprise answers under /api/v3 on its own host", () => {
    const a = adapter("https://git.example.test/acme/widgets", "github");
    expect(a.apiBase).toBe(
      "https://git.example.test/api/v3/repos/acme/widgets/",
    );
    expect(a.archiveUrl("main")).toBe(
      "https://git.example.test/acme/widgets/archive/main.tar.gz",
    );
  });

  test("GitLab answers under /api/v4 with the path encoded once", () => {
    const a = adapter("https://gitlab.com/acme/tools/cli", "github");
    expect(a.kind).toBe("gitlab");
    expect(a.apiBase).toBe(
      "https://gitlab.com/api/v4/projects/acme%2Ftools%2Fcli/",
    );
    expect(a.lookupUrl("")).toBe(
      "https://gitlab.com/api/v4/projects/acme%2Ftools%2Fcli/repository/commits/HEAD",
    );
    expect(a.lookupUrl("feature/x")).toBe(
      "https://gitlab.com/api/v4/projects/acme%2Ftools%2Fcli/repository/commits/feature%2Fx",
    );
    expect(a.lookupHeaders).toEqual({});
    expect(a.tarballUrl(sha)).toBe(
      `https://gitlab.com/api/v4/projects/acme%2Ftools%2Fcli/repository/archive.tar.gz?sha=${sha}`,
    );
    expect(a.archiveUrl("")).toBe(
      "https://gitlab.com/acme/tools/cli/-/archive/HEAD/cli-HEAD.tar.gz",
    );
    expect(a.archiveUrl("feature/x")).toBe(
      "https://gitlab.com/acme/tools/cli/-/archive/feature/x/cli-feature-x.tar.gz",
    );
    const self = adapter("https://git.example.test/acme/widgets", "gitlab");
    expect(self.apiBase).toBe(
      "https://git.example.test/api/v4/projects/acme%2Fwidgets/",
    );
  });
});

describe("a credential's prefix", () => {
  const base = "https://api.github.com/repos/acme/widgets/";
  test.each([
    ["https://api.github.com/", true],
    ["https://api.github.com/repos/acme/", true],
    ["https://api.github.com/repos/acme", true],
    ["https://api.github.com/repos/acme/widgets/", true],
    ["https://api.github.com/repos/ac", false],
    ["https://api.github.com/repos/acme/widgets-x/", false],
    ["https://api.github.com/repos/other/", false],
    ["https://github.com/", false],
    ["https://api.github.com:8443/", false],
  ])("%s covers the API: %p", (prefix, expected) => {
    expect(covers(prefix as string, base)).toBe(expected as boolean);
  });

  test("covers GitLab's API from /api/v4/, since a prefix holds no escape", () => {
    const gitlab = "https://gitlab.com/api/v4/projects/acme%2Fwidgets/";
    expect(covers("https://gitlab.com/api/v4/", gitlab)).toBe(true);
    expect(covers("https://gitlab.com/api/v4/projects/", gitlab)).toBe(true);
    expect(covers("https://gitlab.com/api/v3/", gitlab)).toBe(false);
    expect(covers("https://git.example.test/api/v4/", gitlab)).toBe(false);
  });
});
