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
import { projects } from "../../../src/client/data/projects.ts";
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
  dirtyOf,
  draftOf,
  keyHint,
  keyLine,
  keyOptions,
  keyUsers,
  patchBody,
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
import type { Me } from "../../../src/shared/contracts/user.ts";

const admin: Me = {
  id: "u1",
  username: "admin",
  fullName: "Admin",
  role: "admin",
  mustChangePassword: false,
};

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

const realFetch = globalThis.fetch;
let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  me.value = admin;
  credentials.value = null;
  credentialKeys.value = [];
  credentialsError.value = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    answer(url, init)) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the model", () => {
  test("a new credential starts on GET and HEAD, with no key or project", () => {
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
  });

  test("the key picks mark a file that cannot be used, and one gone", () => {
    const keys = [
      { name: "http-finnhub", usable: true },
      { name: "http-short", usable: false },
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
  });

  test("the row's key line is a failure unless the file is usable", () => {
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
  });

  test("the row's and the cards' words", () => {
    expect(keyHint("http-finnhub", credential())).toBe(
      "http-finnhub.key is present",
    );
    expect(keyHint("http-finnhub", credential({ key: "unusable" }))).toBe(
      "http-finnhub.key is unusable",
    );
    // a new pick says what to pick, not the saved file's state
    expect(keyHint("http-other", credential())).toBe(
      "An http- file in the secrets directory",
    );
    expect(keyHint("", null)).toBe("An http- file in the secrets directory");
    expect(deleteLine(credential())).toBe(
      "curl stops signing requests under https://finnhub.io/api/v1/.",
    );
    expect(projectsLine(credential())).toBe("finops");
    expect(projectsLine(credential({ projects: [] }))).toBe("no projects");
  });

  test("the methods keep the server's order", () => {
    expect(toggledMethod(["GET"], "HEAD")).toEqual(["GET", "HEAD"]);
    expect(toggledMethod(["POST"], "GET")).toEqual(["GET", "POST"]);
    expect(toggledMethod(["GET", "HEAD"], "GET")).toEqual(["HEAD"]);
  });

  test("a refusal's field", () => {
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

  test("the form checks what is empty before a call", () => {
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

  test("a change sends only the fields it touched", () => {
    const c = credential();
    const d = draftOf(c);
    expect(dirtyOf(d, c)).toBe(false);
    expect(patchBody(d, c)).toEqual({});
    expect(patchBody({ ...d, projectIds: [] }, c)).toEqual({ projectIds: [] });
    expect(
      patchBody(
        { ...d, methods: ["GET", "POST"], template: "Bearer {key}" },
        c,
      ),
    ).toEqual({ methods: ["GET", "POST"], template: "Bearer {key}" });
    expect(dirtyOf({ ...d, keyName: "http-other" }, c)).toBe(true);
  });
});

describe("the entity", () => {
  test.serial("loads the rows by name with the keys", async () => {
    answer = () =>
      Response.json({
        credentials: [credential({ id: "c2", name: "github" }), credential()],
        keys: [{ name: "http-finnhub", usable: true }],
      });
    await loadCredentials();
    expect(credentials.value?.map((c) => c.name)).toEqual([
      "finnhub",
      "github",
    ]);
    expect(credentialKeys.value).toEqual([
      { name: "http-finnhub", usable: true },
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
  test("sends and counts only its own fields", () => {
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

  test("checks only its own fields before a call", () => {
    const d = { ...draftOf(credential()), prefix: "" };
    expect(cardProblem(d, ["methods"])).toBeNull();
    expect(cardProblem(d, ["prefix", "header", "template"])?.field).toBe(
      "prefix",
    );
  });

  test("a refusal about another card's field is its notice", () => {
    const projects = cardFieldOf(["projectIds"]);
    expect(projects("the prefix overlaps github in finops")).toBeUndefined();
    expect(projects("finops has 10 credentials")).toBe("projectIds");
    expect(cardFieldOf(["prefix"])("the prefix overlaps a in b")).toBe(
      "prefix",
    );
  });

  test("a key file names its one reader, or counts them", () => {
    const list = [
      credential(),
      credential({ id: "c2", name: "b", keyName: "http-shared" }),
      credential({ id: "c3", name: "c", keyName: "http-shared" }),
    ];
    expect(keyUsers("http-finnhub", list)).toEqual({
      label: "finnhub",
      name: "finnhub",
      count: 1,
    });
    expect(keyUsers("http-shared", list)).toEqual({
      label: "2 credentials",
      name: null,
      count: 2,
    });
    expect(keyUsers("http-none", list)).toEqual({
      label: "unused",
      name: null,
      count: 0,
    });
  });
});

describe("the teams a credential may bind", () => {
  test("team projects by name, and a bound one the admin lacks", () => {
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

  test.serial("the list says credentials sign nothing while web is off", () => {
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
    };
    const html = render(<CredentialList />);
    expect(html).toContain(
      "Web access is off. Credentials sign nothing until it is on.",
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
      } as (typeof projects.value & object)[number],
    ];
    const html = render(<CredentialPage params={{ name: "finnhub" }} />);
    expect(
      [...html.matchAll(/setting-title">([^<]+)</g)].map((m) => m[1]),
    ).toEqual(["Key", "Request", "Methods", "Projects", "Delete finnhub"]);
    expect(html.match(/<form/g)).toHaveLength(4);
    // nothing to save at rest
    expect(html.match(/type="submit"[^>]*disabled/g)).toHaveLength(4);
    expect(html).not.toContain("Unsaved changes");
    // the saved fields, the name fixed
    expect(html).not.toContain('name="name"');
    expect(html).toContain('value="https://finnhub.io/api/v1/"');
    expect(html).toContain('value="X-Finnhub-Token"');
    expect(html).toContain("http-finnhub.key is present");
    // only what it is bound to, each with a remove, Add over the rest
    expect(html).toMatch(/setting-count">1</);
    expect(html).toContain('aria-label="Remove finops"');
    expect(html).toContain("Add project");
    expect(html).not.toContain('name="projectIds"');
    expect(html).toContain(
      "curl stops signing requests under https://finnhub.io/api/v1/.",
    );
    // the crumb climbs to the tab, the switcher names the other
    expect(html).toContain('href="/admin/config/web/credentials"');
    expect(html).toContain("page-pill");
    // the aside
    expect(html).toMatch(/Key file<span class="split-strong cut">/);
    expect(html).toContain("1 project");
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
    expect(html).toContain("It signs nothing until a project is added.");
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
