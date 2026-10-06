// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  type CredentialsView,
  type Inventory,
  preflight,
} from "../../../src/server/provision/parse.ts";
import { testApp } from "../../helpers/app.ts";
import { documents, object } from "./helpers.ts";

const KEY = "github-test-key-0123456789";

const repository = (name: string, spec: Record<string, unknown> = {}) =>
  object("Repository", name, {
    project: "platform",
    url: "https://github.com/acme/widgets",
    ...spec,
  });

const inventory = (existing: Partial<Inventory> = {}): Inventory => ({
  User: [],
  Mail: [],
  Project: ["platform", "finops"],
  Credential: [],
  Repository: [],
  Provider: [],
  Decider: [],
  Skill: [],
  McpServer: [],
  Agent: [],
  Tool: ["web", "websearch", "visualize"],
  ...existing,
});

function check(
  docs: ReturnType<typeof documents>,
  view: Partial<CredentialsView> = {},
  existing: Partial<Inventory> = {},
) {
  return preflight(
    docs,
    inventory(existing),
    () => null,
    { mode: "all", domains: [] },
    () => ({ caps: DEFAULT_LIMITS, live: [] }),
    { key: () => "ok", list: () => [], ...view },
  );
}

describe("repository documents", () => {
  test("the spec is parsed with the routes' rules", () => {
    const [doc] = documents(
      repository("widgets", {
        url: "https://GitHub.com/acme/widgets.git",
        ref: "main",
        ignore: "/*\n!/charts/\n",
      }),
    );
    expect(doc?.spec).toEqual({
      project: "platform",
      url: "https://github.com/acme/widgets",
      ref: "main",
      ignore: "/*\n!/charts/\n",
    });
    const refused: [Record<string, unknown>, string][] = [
      [{ project: "personal" }, "spec.project: cannot name a personal project"],
      [
        { url: "http://github.com/acme/widgets" },
        "spec.url: url must be https",
      ],
      [{ kind: "gitea" }, "spec.kind"],
      [{ ref: "a..b" }, "spec.ref"],
      [{ ignore: "x\n".repeat(201) }, "spec.ignore"],
      [{ name: "Widgets" }, "spec.name"],
      [{ keyFrom: 3 }, "spec.keyFrom"],
      [{ keyFrom: "github" }, "spec.keyFrom"],
      [{ extra: true }, "spec.extra is an unknown field"],
    ];
    for (const [spec, words] of refused) {
      expect(() => documents(repository("widgets", spec))).toThrow(words);
    }
    expect(() =>
      documents(
        object("Repository", "widgets", { url: "https://github.com/a/b" }),
      ),
    ).toThrow("spec.project");
  });

  test("a new one needs a url and a project that will exist", () => {
    expect(() =>
      check(documents(repository("widgets", { url: undefined }))),
    ).toThrow("Repository/widgets: spec.url is required for a new object");
    check(
      documents(repository("widgets", { url: undefined })),
      {},
      {
        Repository: ["platform/widgets"],
      },
    );
    expect(() =>
      check(documents(repository("widgets", { project: "research" }))),
    ).toThrow("spec.project references missing Project/research");
    check(
      documents(
        object("Project", "research", {}),
        repository("widgets", { project: "research" }),
      ),
    );
  });

  test("one per project and name, at most ten to a project", () => {
    expect(() =>
      check(
        documents(
          repository("platform-widgets", { name: "widgets" }),
          repository("other", { name: "widgets" }),
        ),
      ),
    ).toThrow(
      "Repository/other: spec.name widgets is also in platform as Repository/platform-widgets",
    );
    // the same name in two projects is two folders
    check(
      documents(
        repository("platform-widgets", { name: "widgets" }),
        repository("finops-widgets", { name: "widgets", project: "finops" }),
      ),
    );
    const live = Array.from({ length: 9 }, (_, i) => `platform/repo-${i}`);
    check(documents(repository("widgets")), {}, { Repository: live });
    expect(() =>
      check(
        documents(repository("widgets"), repository("more")),
        {},
        {
          Repository: live,
        },
      ),
    ).toThrow("a project holds at most 10 repositories");
    // one the instance holds is not counted twice
    check(
      documents(repository("repo-1")),
      {},
      {
        Repository: [...live, "platform/widgets"],
      },
    );
  });

  test("a key file is present and usable, and no credential is asked", () => {
    check(documents(repository("widgets", { keyFrom: "http-github" })));
    check(documents(repository("widgets", { keyFrom: null })));
    expect(() =>
      check(documents(repository("widgets", { keyFrom: "http-github" })), {
        key: () => "missing",
      }),
    ).toThrow(
      "Repository/widgets: spec.keyFrom secret http-github.key is missing",
    );
    expect(() =>
      check(documents(repository("widgets", { keyFrom: "http-github" })), {
        key: () => "unusable",
      }),
    ).toThrow("spec.keyFrom secret http-github.key must hold");
  });
});

describe("repository apply", () => {
  test("creates, leaves alone and changes a repository by project and name", async () => {
    const app = await testApp({
      activate: false,
      secrets: { "http-github": KEY },
    });
    try {
      const base = [
        object("Project", "platform", { description: "A team project." }),
      ];
      const lines: string[] = [];
      const report = (line: string) => lines.push(line);
      await app.provision.apply(
        documents(
          ...base,
          repository("widgets", { keyFrom: "http-github", ref: "main" }),
        ),
        report,
      );
      expect(lines).toContain("created repository/widgets");
      const projectId = app.projects.teamProjectIds()[0]!;
      const [row] = app.repos.store.forProject(projectId);
      expect(row).toMatchObject({
        name: "widgets",
        url: "https://github.com/acme/widgets",
        ref: "main",
        state: "pending",
      });
      expect(row?.keyName).toBe("http-github");
      app.repos.store.setFetched(row!.id, {
        state: "ready",
        error: null,
        commit: "a".repeat(40),
      });
      lines.length = 0;
      await app.provision.apply(
        documents(
          ...base,
          repository("widgets", { keyFrom: "http-github", ref: "main" }),
        ),
        report,
      );
      expect(lines).toContain("unchanged repository/widgets");
      expect(app.repos.store.byId(row!.id)?.state).toBe("ready");
      lines.length = 0;
      await app.provision.apply(
        documents(
          ...base,
          repository("widgets", { keyFrom: null, ignore: "*.md\n" }),
        ),
        report,
      );
      expect(lines).toContain("updated repository/widgets");
      expect(app.repos.store.byId(row!.id)).toMatchObject({
        keyName: null,
        ignore: "*.md\n",
        ref: "main",
        state: "pending",
      });
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });
});
