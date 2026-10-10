// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The credential pages: the form's defaults and what a save sends, the
// key picks and marks, which field a refusal names; the entity that
// loads the list with the keys and folds a write back; the list, a
// credential's page and New credential rendered.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  addCredential,
  credentialKeys,
  credentials,
  credentialsError,
  deleteCredential,
  loadCredentials,
  patchCredential,
} from "../../../src/client/data/credentials.ts";
import { me } from "../../../src/client/data/me.ts";
import { projects, projectsError } from "../../../src/client/data/projects.ts";
import { tools } from "../../../src/client/data/tools.ts";
import { CredentialList } from "../../../src/client/views/admin/CredentialList.tsx";
import { CredentialPage } from "../../../src/client/views/admin/CredentialPage.tsx";
import {
  cardBody,
  cardFieldOf,
  cardProblem,
  createBody,
  credentialFieldOf,
  deleteLine,
  draftOf,
  keyHint,
  keyLine,
  keyOptions,
  keyReader,
  problemOf,
  projectsLine,
  teamsOf,
  toggledMethod,
} from "../../../src/client/views/admin/Credentials.model.ts";
import { NewCredential } from "../../../src/client/views/admin/NewCredential.tsx";
import type {
  CredentialSummary,
  HttpMethod,
} from "../../../src/shared/contracts/credential.ts";
import { clientFetch } from "../../helpers/client-fetch.ts";
import {
  admin as adminFixture,
  automationTool,
  emailUser,
} from "../../helpers/client-fixtures.ts";

const admin = adminFixture({ fullName: "Admin" });

const credential = (
  changes: Partial<CredentialSummary> = {},
): CredentialSummary => ({
  id: "c1",
  name: "finnhub",
  keyName: "http-finnhub",
  key: "ok",
  prefix: "https://finnhub.io/api/v1/",
  header: "X-Finnhub-Token",
  template: "{key}",
  methods: ["GET"],
  projects: [{ id: "p1", name: "finops" }],
  createdAt: 1,
  updatedAt: 1,
  ...changes,
});

let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;
clientFetch((url, init) => answer(url, init));

beforeEach(() => {
  me.value = admin;
  credentials.value = null;
  credentialKeys.value = [];
  credentialsError.value = null;
});

describe("the model", () => {
  test.serial(
    "a new credential starts on GET and HEAD, with no key or project",
    () => {
      expect(draftOf(null)).toEqual({
        name: "",
        keyName: "",
        prefix: "",
        header: "",
        template: "",
        methods: ["GET", "HEAD"],
        projectIds: [],
      });
      expect(draftOf(credential())).toMatchObject({
        keyName: "http-finnhub",
        methods: ["GET"],
        projectIds: ["p1"],
      });
    },
  );

  test.serial(
    "the key picks mark a file that cannot be used, and one gone",
    () => {
      const keys = [
        { name: "http-finnhub", usable: true, repos: [] },
        { name: "http-short", usable: false, repos: [] },
      ];
      expect(keyOptions(keys, "")).toEqual([
        { value: "http-finnhub", label: "http-finnhub" },
        { value: "http-short", label: "http-short", detail: "unusable" },
      ]);
      expect(keyOptions(keys, "http-gone").at(-1)).toEqual({
        value: "http-gone",
        label: "http-gone",
        detail: "missing",
      });
      expect(keyOptions(keys, "http-finnhub")).toHaveLength(2);
    },
  );

  test.serial(
    "the row's key line is a failure unless the file is usable",
    () => {
      expect(keyLine("http-a", "ok")).toEqual({
        text: "http-a.key",
        bad: false,
      });
      expect(keyLine("http-a", "missing")).toEqual({
        text: "http-a.key missing",
        bad: true,
      });
      expect(keyLine("http-a", "unusable")).toEqual({
        text: "http-a.key unusable",
        bad: true,
      });
    },
  );

  test.serial("the row's and the cards' words", () => {
    expect(keyHint("http-finnhub", credential())).toBe(
      "http-finnhub.key is present",
    );
    expect(keyHint("http-finnhub", credential({ key: "unusable" }))).toBe(
      "http-finnhub.key is unusable",
    );
    // a new pick says what to pick, not the saved file's state
    expect(keyHint("http-other", credential())).toBe(null);
    expect(keyHint("", null)).toBeNull();
    expect(deleteLine(credential())).toBe(
      "curl stops adding the header to requests under https://finnhub.io/api/v1/.",
    );
    expect(projectsLine(credential())).toBe("finops");
    expect(projectsLine(credential({ projects: [] }))).toBe("no projects");
  });

  test.serial("the methods keep the server's order", () => {
    expect(toggledMethod(["GET"], "HEAD")).toEqual(["GET", "HEAD"]);
    expect(toggledMethod(["POST"], "GET")).toEqual(["GET", "POST"]);
    expect(toggledMethod(["GET", "HEAD"], "GET")).toEqual(["HEAD"]);
  });

  test.serial("a refusal's field", () => {
    expect(credentialFieldOf("name must be 2 to 80 characters")).toBe("name");
    expect(credentialFieldOf("a credential named finnhub exists")).toBe("name");
    expect(credentialFieldOf("keyName must be http- followed by")).toBe(
      "keyName",
    );
    expect(credentialFieldOf("prefix must be https")).toBe("prefix");
    expect(credentialFieldOf("the prefix overlaps github in finops")).toBe(
      "prefix",
    );
    expect(credentialFieldOf("header host cannot carry a key")).toBe("header");
    expect(credentialFieldOf("template must hold {key} exactly once")).toBe(
      "template",
    );
    expect(credentialFieldOf("methods must be distinct names")).toBe("methods");
    expect(credentialFieldOf("no such team project p9")).toBe("projectIds");
    expect(credentialFieldOf("finops has 10 credentials")).toBe("projectIds");
    expect(credentialFieldOf("no such credential")).toBeUndefined();
  });

  test.serial("the form checks what is empty before a call", () => {
    const d = { ...draftOf(null), name: "finnhub" };
    expect(problemOf(d, true)?.field).toBe("keyName");
    expect(problemOf({ ...draftOf(null) }, true)?.field).toBe("name");
    const full = {
      ...d,
      keyName: "http-finnhub",
      prefix: " https://finnhub.io/api/v1/ ",
      header: "X-Finnhub-Token",
      template: "{key}",
    };
    expect(problemOf(full, true)).toBeNull();
    expect(problemOf({ ...full, methods: [] }, true)?.field).toBe("methods");
    expect(createBody(full)).toEqual({
      name: "finnhub",
      keyName: "http-finnhub",
      prefix: "https://finnhub.io/api/v1/",
      header: "X-Finnhub-Token",
      template: "{key}",
      methods: ["GET", "HEAD"],
      projectIds: [],
    });
  });

  test.serial("a change sends only the fields it touched", () => {
    const all = [
      "keyName",
      "prefix",
      "header",
      "template",
      "methods",
      "projectIds",
    ] as const;
    const c = credential();
    const d = draftOf(c);
    expect(cardBody(d, c, all)).toEqual({});
    expect(cardBody({ ...d, projectIds: [] }, c, all)).toEqual({
      projectIds: [],
    });
    expect(
      cardBody(
        { ...d, methods: ["GET", "POST"], template: "Bearer {key}" },
        c,
        all,
      ),
    ).toEqual({ methods: ["GET", "POST"], template: "Bearer {key}" });
    expect(cardBody({ ...d, keyName: "http-other" }, c, all)).toEqual({
      keyName: "http-other",
    });
  });
});

describe("the entity", () => {
  test.serial("loads the rows by name with the keys", async () => {
    answer = () =>
      Response.json({
        credentials: [credential({ id: "c2", name: "github" }), credential()],
        keys: [{ name: "http-finnhub", usable: true, repos: [] }],
      });
    await loadCredentials();
    expect(credentials.value?.map((c) => c.name)).toEqual([
      "finnhub",
      "github",
    ]);
    expect(credentialKeys.value).toEqual([
      { name: "http-finnhub", usable: true, repos: [] },
    ]);
  });

  test.serial("a write that finds the row gone drops it", async () => {
    credentials.value = [credential(), credential({ id: "c2", name: "x" })];
    answer = () =>
      Response.json({ error: "no such credential" }, { status: 404 });
    await expect(patchCredential("c1", { methods: ["GET"] })).rejects.toThrow();
    expect(credentials.value?.map((c) => c.id)).toEqual(["c2"]);
    // a delete of a row already gone is done, not refused
    await deleteCredential("c2");
    expect(credentials.value).toEqual([]);
  });

  test.serial(
    "a save answered after its row was deleted keeps it out",
    async () => {
      credentials.value = [credential({ id: "c2", name: "x" })];
      answer = () => Response.json({ credential: credential() });
      await patchCredential("c1", { methods: ["GET"] });
      expect(credentials.value?.map((c) => c.id)).toEqual(["c2"]);
    },
  );

  test.serial("a failed write keeps a load that was in flight", async () => {
    credentials.value = [];
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    answer = async (_url, init) => {
      if (init?.method === "PATCH") {
        return Response.json({ error: "nope" }, { status: 500 });
      }
      await held;
      return Response.json({ credentials: [credential()], keys: [] });
    };
    const load = loadCredentials();
    await expect(patchCredential("c1", { methods: ["GET"] })).rejects.toThrow();
    release();
    await load;
    expect(credentials.value?.map((c) => c.id)).toEqual(["c1"]);
  });

  test.serial("a failed load is the page's error", async () => {
    answer = () => Response.json({ error: "nope" }, { status: 500 });
    await loadCredentials();
    expect(credentialsError.value).not.toBeNull();
  });

  test.serial("a write folds the server's row back", async () => {
    credentials.value = [credential()];
    const calls: string[] = [];
    answer = (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(String(init?.body));
      return Response.json({
        credential: credential({
          id: init?.method === "POST" ? "c2" : "c1",
          name: body.name ?? "finnhub",
          methods: body.methods ?? ["GET"],
        }),
      });
    };
    await addCredential({
      name: "alpha",
      keyName: "http-a",
      prefix: "https://a.test/",
      header: "Authorization",
      template: "Bearer {key}",
    });
    expect(credentials.value?.map((c) => c.name)).toEqual(["alpha", "finnhub"]);
    await patchCredential("c1", { methods: ["GET", "POST"] });
    expect(credentials.value?.find((c) => c.id === "c1")?.methods).toEqual([
      "GET",
      "POST",
    ]);
    await deleteCredential("c1");
    expect(credentials.value?.map((c) => c.id)).toEqual(["c2"]);
    expect(calls).toEqual([
      "POST /api/credentials",
      "PATCH /api/credentials/c1",
      "DELETE /api/credentials/c1",
    ]);
  });
});

describe("a card of the page", () => {
  test.serial("sends and counts only its own fields", () => {
    // a template the server kept with a space round it: trimmed by the
    // draft, yet no other card may carry it
    const row = credential({ template: "Bearer {key} " });
    const d = { ...draftOf(row), methods: ["GET", "POST"] as HttpMethod[] };
    expect(cardBody(d, row, ["methods"])).toEqual({
      methods: ["GET", "POST"],
    });
    expect(cardBody(draftOf(row), row, ["methods"])).toEqual({});
    expect(cardBody(draftOf(row), row, ["keyName"])).toEqual({});
    // the card that owns it is not dirty over those spaces either
    expect(
      cardBody(draftOf(row), row, ["prefix", "header", "template"]),
    ).toEqual({});
  });

  test.serial("checks only its own fields before a call", () => {
    const d = { ...draftOf(credential()), prefix: "" };
    expect(cardProblem(d, ["methods"])).toBeNull();
    expect(cardProblem(d, ["prefix", "header", "template"])?.field).toBe(
      "prefix",
    );
  });

  test.serial("a refusal about another card's field is its notice", () => {
    const projects = cardFieldOf(["projectIds"]);
    expect(projects("the prefix overlaps github in finops")).toBeUndefined();
    expect(projects("finops has 10 credentials")).toBe("projectIds");
    expect(cardFieldOf(["prefix"])("the prefix overlaps a in b")).toBe(
      "prefix",
    );
  });

  test.serial("a key file names its one reader, or counts them", () => {
    const list = [
      credential(),
      credential({ id: "c2", name: "b", keyName: "http-shared" }),
      credential({ id: "c3", name: "c", keyName: "http-shared" }),
    ];
    const reader = keyReader(list, [
      { name: "http-finnhub", usable: true, repos: [] },
      { name: "http-shared", usable: true, repos: ["platform/widgets"] },
      { name: "http-repo", usable: true, repos: ["platform/widgets"] },
      { name: "http-repos", usable: true, repos: ["a/b", "c/d"] },
    ]);
    expect(reader("http-finnhub")).toEqual({
      label: "finnhub",
      href: "/admin/config/web/credentials/finnhub",
    });
    expect(reader("http-shared")).toEqual({
      label: "2 credentials, 1 repository",
    });
    // a repository reads a key without a credential: it is used
    expect(reader("http-repo")).toEqual({ label: "platform/widgets" });
    expect(reader("http-repos")).toEqual({ label: "2 repositories" });
    expect(reader("http-none")).toEqual({ label: "unused", quiet: true });
  });
});

describe("the teams a credential may bind", () => {
  test.serial("team projects by name, and a bound one the admin lacks", () => {
    const seen = [
      { id: "p2", name: "research", kind: "team" },
      { id: "p9", name: "mine", kind: "personal" },
      { id: "p3", name: "alpha", kind: "team" },
    ];
    expect(teamsOf(seen, null).map((p) => p.name)).toEqual([
      "alpha",
      "research",
    ]);
    expect(teamsOf(seen, credential()).map((p) => p.name)).toEqual([
      "alpha",
      "finops",
      "research",
    ]);
  });
});

describe("the pages", () => {
  const two = () => [
    credential(),
    credential({
      id: "c2",
      name: "github",
      keyName: "http-github",
      key: "missing",
      prefix: "https://api.github.com/",
      projects: [],
    }),
  ];
  let heldTools: typeof tools.value;
  let heldProjects: typeof projects.value;
  beforeEach(() => {
    heldTools = tools.value;
    heldProjects = projects.value;
  });
  afterEach(() => {
    tools.value = heldTools;
    projects.value = heldProjects;
  });

  test.serial("the list: a link per credential, a missing key marked", () => {
    credentials.value = two();
    const html = render(<CredentialList />);
    expect(html).toContain('href="/admin/config/web/credentials/finnhub"');
    expect(html).toContain('href="/admin/config/web/credentials/github"');
    // no note over the rows while web access is on
    expect(html).not.toContain("credentials-off");
    expect(html).toContain("https://finnhub.io/api/v1/ · finops");
    expect(html).toContain("http-github.key missing");
    expect(html.match(/rows-meta-bad/g)?.length).toBe(1);
    // no form on the list, nothing opens in place
    expect(html).not.toContain("<form");
  });

  test.serial("the list says no credential is used while web is off", () => {
    credentials.value = [credential()];
    tools.value = {
      builtin: [],
      access: { mode: "off", domains: [], updatedAt: 0 },
      search: {
        provider: null,
        keys: { exa: false, firecrawl: false, tavily: false },
      },
      visualize: {
        name: "visualize",
        description: "",
        parameters: {},
        parametersHtml: "",
        tokens: 0,
        enabled: true,
        hosts: [],
        updatedAt: 0,
      },
      emailUser: emailUser(),
      automation: automationTool(),
    };
    const html = render(<CredentialList />);
    expect(html).toContain(
      "Web access is off. No credential is used until it is on.",
    );
  });

  test.serial("an empty list says what New credential takes", () => {
    credentials.value = [];
    expect(render(<CredentialList />)).toContain("No credentials yet.");
  });

  test.serial("a credential's page: a form per card, Delete last", () => {
    credentials.value = two();
    projects.value = [
      {
        id: "p1",
        name: "finops",
        kind: "team",
        createdAt: 0,
        memberCount: 1,
      },
    ];
    const html = render(<CredentialPage params={{ name: "finnhub" }} />);
    const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
    expect(forms).toHaveLength(4);
    for (const [index, title] of [
      "Key",
      "Request",
      "Methods",
      "Projects",
    ].entries()) {
      expect(forms[index]).toMatch(new RegExp(`<h2\\b[^>]*>${title}<`));
    }
    expect(html).toMatch(/<h2\b[^>]*>Delete finnhub<\/h2>/);
    expect(html.indexOf(">Delete finnhub<")).toBeGreaterThan(
      html.lastIndexOf("</form>"),
    );
    expect(html.match(/type="submit"[^>]*disabled/g)).toHaveLength(4);
    expect(html).not.toContain("Unsaved changes");
    expect(html).not.toContain('name="name"');
    expect(html).toContain('value="https://finnhub.io/api/v1/"');
    expect(html).toContain('value="X-Finnhub-Token"');
    expect(html).toContain("http-finnhub.key is present");
    expect(html).toMatch(/setting-count">1</);
    expect(html).toContain('aria-label="Remove finops"');
    expect(html).toContain("Add project");
    expect(html).not.toContain('name="projectIds"');
    expect(html).toContain(deleteLine(credential()));
    expect(html).toContain('href="/admin/config/web/credentials"');
    expect(html).toContain("page-pill");
    // the aside
    expect(html).toMatch(/Key file<span class="split-strong cut">/);
    expect(html).toContain("1 project");
  });

  test.serial("the Projects card says when the projects did not load", () => {
    credentials.value = two();
    projects.value = null;
    projectsError.value = { words: "nope", status: 500 };
    try {
      const html = render(<CredentialPage params={{ name: "finnhub" }} />);
      expect(html).toContain("Did not load.");
      expect(html).not.toContain("Add project");
    } finally {
      projectsError.value = null;
    }
  });

  test.serial("an unknown name says so", () => {
    credentials.value = two();
    expect(render(<CredentialPage params={{ name: "gone" }} />)).toContain(
      "No credential by that name.",
    );
  });

  test.serial("New credential: one card, Create off until named", () => {
    credentials.value = two();
    projects.value = [];
    const html = render(<NewCredential />);
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).toContain('name="name"');
    expect(html).toContain("Create credential");
    expect(html).toMatch(/type="submit"[^>]*disabled/);
    expect(html).toContain('href="/admin/config/web/credentials"');
    expect(html).toContain("No projects yet.");
    // GET and HEAD are on for a new one
    expect(html.match(/rows-check-on/g)).toHaveLength(2);
  });

  test.serial("the pages wait for the list", () => {
    credentials.value = null;
    const waiting = render(<CredentialList />);
    expect(waiting).toContain("Loading");
    expect(waiting).not.toContain("No credentials yet");
    expect(render(<CredentialPage params={{ name: "x" }} />)).toContain(
      "Loading",
    );
    expect(render(<NewCredential />)).toContain("Loading");
    expect(render(<CredentialList />)).not.toContain("rows-go");
  });
});
