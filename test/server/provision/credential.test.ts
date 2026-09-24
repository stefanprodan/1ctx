// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { CredentialStore } from "../../../src/server/credentials/index.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  type CredentialsView,
  type Inventory,
  preflight,
} from "../../../src/server/provision/parse.ts";
import type { KeyState } from "../../../src/shared/contracts/credential.ts";
import { type TestApp, testApp } from "../../helpers/app.ts";
import { documents, mutations, object } from "./helpers.ts";

const KEY = "quotes-test-key-0123456789";

const credential = (name: string, spec: Record<string, unknown> = {}) =>
  object("Credential", name, {
    keyFrom: "http-quotes",
    url: "https://quotes.example.test/api/v1/",
    header: "X-Api-Key",
    value: "{key}",
    projects: ["finops"],
    ...spec,
  });

const inventory = (existing: Partial<Inventory> = {}): Inventory => ({
  User: [],
  Project: ["finops", "research"],
  Credential: [],
  Provider: [],
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

describe("credential preflight", () => {
  test("a new credential names its key, url, header and value", () => {
    for (const field of ["keyFrom", "url", "header", "value"]) {
      const spec = credential("quotes").spec as Record<string, unknown>;
      const { [field]: _, ...rest } = spec;
      expect(() =>
        check(documents(object("Credential", "quotes", rest))),
      ).toThrow(
        `Credential/quotes: spec.${field} is required for a new object`,
      );
    }
    // an existing one may name only what changes
    check(
      documents(object("Credential", "quotes", { methods: ["GET"] })),
      {},
      {
        Credential: ["quotes"],
      },
    );
  });

  test("the key file exists and passes the key's rule", () => {
    const docs = documents(credential("quotes"));
    for (const [state, words] of [
      ["missing", "spec.keyFrom secret http-quotes.key is missing"],
      [
        "unusable",
        "spec.keyFrom secret http-quotes.key must hold 16 to 4096 visible ASCII characters",
      ],
    ] as const) {
      expect(() => check(docs, { key: () => state as KeyState })).toThrow(
        words,
      );
    }
  });

  test("the fields follow the save rules", () => {
    for (const [spec, words] of [
      [
        { url: "http://quotes.example.test/" },
        "spec.url: prefix must be https",
      ],
      [{ header: "Host" }, "spec.header: header Host cannot carry a key"],
      [
        { value: "Bearer" },
        "spec.value: template must hold {key} exactly once",
      ],
      [{ methods: ["TRACE"] }, "spec.methods: methods must be"],
      [{ keyFrom: "mcp-quotes" }, "spec.keyFrom: keyName must be http-"],
      [{ projects: ["finops", "finops"] }, "spec.projects: name finops"],
    ] as const) {
      expect(() => documents(credential("quotes", spec))).toThrow(words);
    }
    const [doc] = documents(
      credential("quotes", { url: "https://Quotes.Example.test./api/" }),
    );
    expect(doc?.kind === "Credential" && doc.spec.url).toBe(
      "https://quotes.example.test/api/",
    );
  });

  test("projects are team projects that exist", () => {
    expect(() =>
      check(documents(credential("quotes", { projects: ["personal"] }))),
    ).toThrow("spec.projects cannot name a personal project");
    expect(() =>
      check(documents(credential("quotes", { projects: ["nowhere"] }))),
    ).toThrow("spec.projects references missing Project/nowhere");
    // a project the same input makes is known
    check(
      documents(
        object("Project", "newteam", {}),
        credential("quotes", { projects: ["newteam"] }),
      ),
    );
  });

  test("two credentials of a project never overlap, in the input or held", () => {
    const narrow = credential("narrow");
    const wide = credential("wide", { url: "https://quotes.example.test/" });
    expect(() => check(documents(narrow, wide))).toThrow(
      "Credential/wide: spec.projects finops: the prefix overlaps Credential/narrow",
    );
    // held in the database, and the input brings a narrower one
    const known = { Credential: ["wide"] };
    const held = {
      list: () => [
        {
          name: "wide",
          prefix: "https://quotes.example.test/",
          projects: ["finops"],
        },
      ],
    };
    expect(() => check(documents(narrow), held, known)).toThrow(
      "Credential/narrow: spec.projects finops: the prefix overlaps Credential/wide",
    );
    // the input moves the held one away, or into another project
    check(
      documents(narrow, object("Credential", "wide", { projects: [] })),
      held,
      known,
    );
    check(
      documents(
        narrow,
        object("Credential", "wide", { url: "https://other.example.test/" }),
      ),
      held,
      known,
    );
    check(
      documents(credential("narrow", { projects: ["research"] })),
      held,
      known,
    );
  });

  test("a project holds at most ten", () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      credential(`api-${String(i).padStart(2, "0")}`, {
        url: `https://api${i}.example.test/`,
      }),
    );
    expect(() => check(documents(...many))).toThrow(
      "Credential/api-10: spec.projects finops: a project holds at most 10 credentials",
    );
    check(documents(...many.slice(0, 10)));
  });
});

async function instance(): Promise<TestApp> {
  const app = await testApp({
    activate: false,
    secrets: { "http-quotes": KEY, "http-repos": `${KEY}-repos` },
  });
  await app.provision.apply(
    documents(
      object("Project", "finops", {}),
      object("Project", "research", {}),
    ),
    () => {},
  );
  return app;
}

const rows = (app: TestApp) =>
  new CredentialStore(app.db).list().map((row) => ({
    ...row,
    projects: row.projectIds.map((id) => app.projects.byId(id)!.name).sort(),
  }));

describe("credential apply", () => {
  test("creates, reapplies unchanged, keeps what is omitted, deletes nothing", async () => {
    const app = await instance();
    try {
      const lines: string[] = [];
      const first = documents(
        credential("quotes", { methods: ["GET", "POST"] }),
        credential("repos", {
          keyFrom: "http-repos",
          url: "https://repos.example.test/",
          header: "Authorization",
          value: "Bearer {key}",
          projects: ["finops", "research"],
        }),
      );
      await app.provision.apply(first, (line) => lines.push(line));
      expect(lines).toEqual([
        "created credential/quotes",
        "created credential/repos",
        "2 created, 0 updated, 0 unchanged",
      ]);
      expect(rows(app)).toMatchObject([
        {
          name: "quotes",
          keyName: "http-quotes",
          prefix: "https://quotes.example.test/api/v1/",
          header: "X-Api-Key",
          template: "{key}",
          methods: ["GET", "POST"],
          projects: ["finops"],
        },
        {
          name: "repos",
          header: "Authorization",
          template: "Bearer {key}",
          methods: ["GET", "HEAD"],
          projects: ["finops", "research"],
        },
      ]);

      const writes = mutations(app.db);
      expect(await app.provision.apply(first, () => {})).toEqual({
        created: 0,
        updated: 0,
        unchanged: 2,
      });
      expect(
        writes().filter((row) =>
          String((row as { object_table: string }).object_table).startsWith(
            "credential",
          ),
        ),
      ).toEqual([]);

      // a supplied list replaces, an omitted field stays, repos is not named
      const change = documents(
        object("Credential", "quotes", {
          methods: ["GET"],
          projects: ["research"],
        }),
      );
      expect(await app.provision.apply(change, () => {})).toEqual({
        created: 0,
        updated: 1,
        unchanged: 0,
      });
      expect(rows(app)).toMatchObject([
        {
          name: "quotes",
          keyName: "http-quotes",
          prefix: "https://quotes.example.test/api/v1/",
          header: "X-Api-Key",
          template: "{key}",
          methods: ["GET"],
          projects: ["research"],
        },
        { name: "repos", projects: ["finops", "research"] },
      ]);
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });

  test("preflight reads the held rows and the key files through the app", async () => {
    const app = await instance();
    try {
      await app.provision.apply(
        documents(credential("wide", { url: "https://quotes.example.test/" })),
        () => {},
      );
      const before = rows(app);
      await expect(
        app.provision.apply(documents(credential("narrow")), () => {}),
      ).rejects.toThrow(
        "Credential/narrow: spec.projects finops: the prefix overlaps Credential/wide",
      );
      await expect(
        app.provision.apply(
          documents(
            credential("other", {
              keyFrom: "http-absent",
              url: "https://other.example.test/",
            }),
          ),
          () => {},
        ),
      ).rejects.toThrow("spec.keyFrom secret http-absent.key is missing");
      expect(rows(app)).toEqual(before);
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });
});
