// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { BadRequest } from "../../../src/server/lib/errors.ts";
import {
  checkRepo,
  desired,
  type RepoCredential,
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
    expect(parsePatchRepo({ ref: "main", credentialId: null })).toEqual({
      ref: "main",
      credentialId: null,
    });
    expect(parsePatchRepo({})).toEqual({});
    expect(words(() => parsePatchRepo({ name: "Widgets" }))).toContain(
      "name must be",
    );
    expect(words(() => parsePatchRepo({ kind: "gitea" }))).toBe(
      "kind must be github or gitlab",
    );
    expect(words(() => parsePatchRepo({ credentialId: "a b" }))).toBe(
      "credentialId must be a credential id or null",
    );
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
      credentialId: null,
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
      { credentialId: "c1" },
      { ignore: "*.md" },
    ]) {
      expect(refetches(held, { ...held, ...change })).toBe(true);
    }
  });
});

const credential = (fields: Partial<RepoCredential> = {}): RepoCredential => ({
  id: "c1",
  name: "github",
  keyName: "http-github",
  prefix: "https://api.github.com/repos/acme/",
  header: "Authorization",
  template: "Bearer {key}",
  methods: ["GET", "HEAD"],
  projectIds: ["team1"],
  ...fields,
});

const port = (
  row: RepoCredential | null,
  key: string | null = "k".repeat(20),
) => ({
  byId: (id: string) => (row !== null && row.id === id ? row : null),
  readKey: () =>
    key === null ? ({ ok: false } as const) : ({ ok: true, key } as const),
  headerValue: (template: string, value: string) =>
    template.replace("{key}", value),
});

const team = { id: "team1", kind: "team" as const };
const personal = { id: "mine", kind: "personal" as const };

describe("who may add what", () => {
  const repo = (fields: Record<string, unknown> = {}) =>
    desired(null, { url: "https://github.com/acme/widgets", ...fields });

  test("a personal project takes public hosts only, without a credential", () => {
    checkRepo(personal, repo(), port(null));
    checkRepo(
      personal,
      desired(null, { url: "https://gitlab.com/acme/widgets" }),
      port(null),
    );
    expect(
      words(() =>
        checkRepo(
          personal,
          desired(null, {
            url: "https://git.example.test/acme/widgets",
            kind: "github",
          }),
          port(null),
        ),
      ),
    ).toContain("github.com or gitlab.com");
    expect(
      words(() =>
        checkRepo(personal, repo({ credentialId: "c1" }), port(credential())),
      ),
    ).toContain("takes no credential");
  });

  test("a team project's credential is bound, covers the API and allows GET", () => {
    checkRepo(
      team,
      desired(null, {
        url: "https://git.example.test/acme/widgets",
        kind: "gitlab",
      }),
      port(null),
    );
    checkRepo(team, repo({ credentialId: "c1" }), port(credential()));
    const cases: [RepoCredential | null, string][] = [
      [null, "no such credential"],
      [credential({ projectIds: ["other"] }), "not bound to this project"],
      [
        credential({ prefix: "https://api.github.com/repos/other/" }),
        "does not cover https://api.github.com/repos/acme/widgets/",
      ],
      [credential({ methods: ["POST"] }), "does not allow GET"],
    ];
    for (const [row, message] of cases) {
      expect(
        words(() => checkRepo(team, repo({ credentialId: "c1" }), port(row))),
      ).toContain(message);
    }
  });
});

describe("the check at each lookup", () => {
  const row = {
    projectId: "team1",
    url: "https://github.com/acme/widgets",
    kind: "github" as const,
    credentialId: "c1",
  };

  test("a public repository sends no header", () => {
    expect(repoAuth({ ...row, credentialId: null }, port(null))).toEqual({
      ok: true,
      header: null,
    });
  });

  test("a credential that still passes signs to its prefix", () => {
    expect(repoAuth(row, port(credential(), "k".repeat(20)))).toEqual({
      ok: true,
      header: {
        name: "Authorization",
        value: `Bearer ${"k".repeat(20)}`,
        prefix: "https://api.github.com/repos/acme/",
      },
    });
  });

  test("deleted, unbound, narrowed, read-only or keyless is no access", () => {
    const refused = { ok: false, error: "no access" } as const;
    expect(repoAuth(row, port(null))).toEqual(refused);
    expect(repoAuth(row, port(credential({ projectIds: [] })))).toEqual(
      refused,
    );
    expect(
      repoAuth(
        row,
        port(credential({ prefix: "https://api.github.com/repos/other/" })),
      ),
    ).toEqual(refused);
    expect(repoAuth(row, port(credential({ methods: ["HEAD"] })))).toEqual(
      refused,
    );
    expect(repoAuth(row, port(credential(), null))).toEqual(refused);
  });
});
