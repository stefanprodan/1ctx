// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { BadRequest } from "../../../src/server/lib/errors.ts";
import {
  checkRepo,
  desired,
  type KeysPort,
  refetches,
  repoAuth,
} from "../../../src/server/repos/check.ts";
import {
  parseCreateRepo,
  parseIgnoreText,
  parsePatchRepo,
} from "../../../src/server/repos/parse.ts";

const words = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequest);
    return (error as Error).message;
  }
  throw new Error("did not refuse");
};

describe("the repository parsers", () => {
  test("a create needs a url and normalizes it", () => {
    expect(
      parseCreateRepo({ url: "https://github.com/acme/widgets.git/" }),
    ).toEqual({ url: "https://github.com/acme/widgets" });
    expect(words(() => parseCreateRepo({}))).toBe("url is required");
    expect(words(() => parseCreateRepo({ url: "x", extra: 1 }))).toBe(
      "unknown field extra",
    );
  });

  test("a change keeps only what it names", () => {
    expect(parsePatchRepo({ ref: "main", keyName: null })).toEqual({
      ref: "main",
      keyName: null,
    });
    expect(parsePatchRepo({ keyName: "http-github" })).toEqual({
      keyName: "http-github",
    });
    expect(parsePatchRepo({})).toEqual({});
    expect(words(() => parsePatchRepo({ name: "Widgets" }))).toContain(
      "name must be",
    );
    expect(words(() => parsePatchRepo({ kind: "gitea" }))).toBe(
      "kind must be github or gitlab",
    );
    for (const keyName of ["github", "http-", "http-A", "mcp-github", 3]) {
      expect(words(() => parsePatchRepo({ keyName }))).toContain(
        "keyName must be http- followed by",
      );
    }
    expect(words(() => parsePatchRepo({ ref: "a..b" }))).toContain(
      "ref must be",
    );
  });

  test("ignore rules are at most 200 lines and 8 KiB", () => {
    const lines = (n: number) => Array.from({ length: n }, () => "*.png");
    expect(parseIgnoreText(lines(200).join("\n"))).toBe(lines(200).join("\n"));
    expect(parseIgnoreText(`${lines(200).join("\n")}\n`)).toContain("*.png");
    expect(words(() => parseIgnoreText(lines(201).join("\n")))).toBe(
      "ignore must be at most 200 lines",
    );
    expect(words(() => parseIgnoreText("a".repeat(8 * 1024 + 1)))).toBe(
      "ignore must be at most 8 KiB",
    );
    // bytes, not characters
    expect(words(() => parseIgnoreText("é".repeat(4097)))).toBe(
      "ignore must be at most 8 KiB",
    );
    expect(words(() => parseIgnoreText(3))).toBe("ignore must be text");
  });

  test("a bad ignore line is refused by its number", () => {
    expect(words(() => parseIgnoreText("dist/\n[abc\n"))).toBe(
      "ignore line 2: unclosed [",
    );
    expect(parseIgnoreText("/*\n!/charts/\n")).toBe("/*\n!/charts/\n");
  });
});

describe("the row a change asks for", () => {
  test("a github URL names exactly an owner and a repository", () => {
    expect(
      words(() =>
        desired(null, {
          url: "https://ghe.example.test/org/team/widgets",
          kind: "github",
        }),
      ),
    ).toBe("url must be https://host/owner/name for github");
    expect(
      desired(null, {
        url: "https://git.example.test/org/team/widgets",
        kind: "gitlab",
      }).url,
    ).toBe("https://git.example.test/org/team/widgets");
  });

  test("a public host fixes the kind and the name defaults to the repo's", () => {
    expect(desired(null, { url: "https://github.com/acme/widgets" })).toEqual({
      name: "widgets",
      url: "https://github.com/acme/widgets",
      kind: "github",
      ref: "",
      keyName: null,
      ignore: "",
    });
    expect(
      words(() =>
        desired(null, {
          url: "https://gitlab.com/acme/widgets",
          kind: "github",
        }),
      ),
    ).toBe("kind must be gitlab for gitlab.com");
  });

  test("another host needs its kind, once", () => {
    expect(
      words(() =>
        desired(null, { url: "https://git.example.test/acme/widgets" }),
      ),
    ).toBe("kind is required for git.example.test");
    // a personal project's form never asks the kind: the host rule speaks
    expect(
      words(() =>
        desired(null, { url: "https://git.example.test/acme/widgets" }, true),
      ),
    ).toBe(
      "a personal project's repository must be on github.com or gitlab.com",
    );
    const held = desired(null, {
      url: "https://git.example.test/acme/widgets",
      kind: "gitlab",
    });
    expect(held.kind).toBe("gitlab");
    expect(desired(held, { ref: "main" })).toEqual({ ...held, ref: "main" });
  });

  test("a name the URL cannot give is asked for", () => {
    expect(
      words(() => desired(null, { url: "https://github.com/acme/_x" })),
    ).toContain("name is required");
    expect(
      desired(null, { url: "https://github.com/acme/_x", name: "x-repo" }).name,
    ).toBe("x-repo");
  });

  test("only what is fetched sets the row pending", () => {
    const held = desired(null, { url: "https://github.com/acme/widgets" });
    expect(refetches(held, { ...held, name: "other" })).toBe(false);
    for (const change of [
      { url: "https://github.com/acme/other" },
      { ref: "main" },
      { keyName: "http-github" },
      { ignore: "*.md" },
    ]) {
      expect(refetches(held, { ...held, ...change })).toBe(true);
    }
  });
});

// key files by name: a value, or why it cannot be read
const port = (
  files: Record<string, string | "missing" | "unusable"> = {},
): KeysPort => ({
  readKey(name) {
    const file = files[name] ?? "missing";
    return file === "missing" || file === "unusable"
      ? { ok: false, reason: file }
      : { ok: true, key: file };
  },
});

const KEY = "k".repeat(20);
const team = { id: "team1", kind: "team" as const };
const personal = { id: "mine", kind: "personal" as const };

describe("who may add what", () => {
  const repo = (fields: Record<string, unknown> = {}) =>
    desired(null, { url: "https://github.com/acme/widgets", ...fields });

  test("a personal project takes public hosts only, without a key", () => {
    checkRepo(personal, repo(), null, port());
    checkRepo(
      personal,
      desired(null, { url: "https://gitlab.com/acme/widgets" }),
      null,
      port(),
    );
    expect(
      words(() =>
        checkRepo(
          personal,
          desired(null, {
            url: "https://git.example.test/acme/widgets",
            kind: "github",
          }),
          null,
          port(),
        ),
      ),
    ).toContain("github.com or gitlab.com");
    expect(
      words(() =>
        checkRepo(
          personal,
          repo({ keyName: "http-github" }),
          null,
          port({ "http-github": KEY }),
        ),
      ),
    ).toBe("a personal project's repository takes no key");
  });

  test("a team project's key names a usable file when it is saved", () => {
    checkRepo(
      team,
      desired(null, {
        url: "https://git.example.test/acme/widgets",
        kind: "gitlab",
      }),
      null,
      port(),
    );
    const named = repo({ keyName: "http-github" });
    checkRepo(team, named, null, port({ "http-github": KEY }));
    expect(words(() => checkRepo(team, named, null, port()))).toBe(
      "keyName http-github is missing",
    );
    expect(
      words(() =>
        checkRepo(team, named, null, port({ "http-github": "unusable" })),
      ),
    ).toBe("keyName http-github is unusable");
    // a key gone since it was saved fails the lookup, never a rename
    checkRepo(team, { ...named, name: "other" }, named, port());
  });
});

describe("the check at each lookup", () => {
  const row = {
    url: "https://github.com/acme/widgets",
    kind: "github" as const,
    keyName: "http-github",
  };

  test("a public repository sends no header", () => {
    expect(repoAuth({ ...row, keyName: null }, port())).toEqual({
      ok: true,
      header: null,
    });
  });

  test("a bearer for either host, sent only under the repository's API base", () => {
    expect(repoAuth(row, port({ "http-github": KEY }))).toEqual({
      ok: true,
      header: {
        name: "authorization",
        value: `Bearer ${KEY}`,
        prefix: "https://api.github.com/repos/acme/widgets/",
      },
    });
    expect(
      repoAuth(
        {
          url: "https://git.example.test/org/team/widgets",
          kind: "gitlab",
          keyName: "http-gitlab",
        },
        port({ "http-gitlab": KEY }),
      ),
    ).toEqual({
      ok: true,
      header: {
        name: "authorization",
        value: `Bearer ${KEY}`,
        prefix:
          "https://git.example.test/api/v4/projects/org%2Fteam%2Fwidgets/",
      },
    });
  });

  test("a missing or unusable key is no access, a replaced one applies", () => {
    const refused = { ok: false, error: "no access" } as const;
    expect(repoAuth(row, port())).toEqual(refused);
    expect(repoAuth(row, port({ "http-github": "unusable" }))).toEqual(refused);
    const files: Record<string, string> = { "http-github": KEY };
    const live = port(files);
    expect(repoAuth(row, live).ok).toBe(true);
    files["http-github"] = "n".repeat(20);
    const again = repoAuth(row, live);
    expect(again.ok && again.header?.value).toBe(`Bearer ${"n".repeat(20)}`);
  });
});
