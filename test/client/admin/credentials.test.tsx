// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Credentials card: the form's defaults and what a save sends, the
// key picks and marks, which field a refusal names; the entity that
// loads the list with the keys and folds a write back; and the card
// rendered.

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
import {
  createBody,
  credentialFieldOf,
  dirtyOf,
  draftOf,
  keyLine,
  keyOptions,
  patchBody,
  problemOf,
  projectsLine,
  toggledMethod,
  totalLine,
} from "../../../src/client/views/admin/CredentialsCard.model.ts";
import { CredentialsCard } from "../../../src/client/views/admin/CredentialsCard.tsx";
import type { CredentialSummary } from "../../../src/shared/contracts/credential.ts";
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

  test("the head's words", () => {
    expect(totalLine(0)).toBe("0 credentials");
    expect(totalLine(1)).toBe("1 credential");
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

describe("the card", () => {
  test.serial("a row per credential, a missing key marked", () => {
    credentials.value = [
      credential(),
      credential({
        id: "c2",
        name: "github",
        keyName: "http-github",
        key: "missing",
        projects: [],
      }),
    ];
    const html = render(<CredentialsCard />);
    expect(html).toContain("2 credentials");
    expect(html).toContain("New credential");
    expect(html).toContain("The key never reaches the chat.");
    expect(html).toContain("https://finnhub.io/api/v1/ · finops");
    expect(html).toContain("http-github.key missing");
    expect(html.match(/rows-meta-bad/g)?.length).toBe(1);
  });

  test.serial("draws nothing until the list loaded", () => {
    expect(render(<CredentialsCard />)).toBe("");
  });
});
