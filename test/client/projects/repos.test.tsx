// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's repositories: the words of a row, the bodies a form
// writes, the entity and its poll, and the list and form as drawn for a
// team project's admin and a personal project's owner.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { options } from "preact";
import { render } from "preact-render-to-string";
import { ApiError } from "../../../src/client/data/api.ts";
import { credentials } from "../../../src/client/data/credentials.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  addRepo,
  changeRepo,
  deleteRepo,
  loadRepos,
  REPO_POLL_MS,
  refreshRepo,
  repoErrorOf,
  repoLists,
  reposOf,
  watchRepos,
} from "../../../src/client/data/repos.ts";
import { Save } from "../../../src/client/lib/save.ts";
import {
  asksKind,
  CAP_LINE,
  createBody,
  credentialOptions,
  draftOf,
  IGNORE_PLACEHOLDER,
  nameOf,
  PUBLIC_HINT,
  patchBody,
  repoFieldOf,
  stateWords,
} from "../../../src/client/views/projects/Repos.model.ts";
import {
  RepoFields,
  RepoForm,
  RepoRows,
  Repos,
} from "../../../src/client/views/projects/Repos.tsx";
import type { RepoView } from "../../../src/shared/api/repos.ts";
import type { CredentialSummary } from "../../../src/shared/contracts/credential.ts";
import {
  DEFAULT_REPO_IGNORE,
  MAX_REPOS_PER_PROJECT,
} from "../../../src/shared/contracts/repo.ts";
import { settle } from "../../helpers/async.ts";
import { clientFetch } from "../../helpers/client-fetch.ts";
import { admin } from "../../helpers/client-fixtures.ts";
import { pollTab } from "../../helpers/poll.ts";

const COMMIT = "3f2a1c9d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39";

function repo(changes: Partial<RepoView> = {}): RepoView {
  return {
    id: "r1",
    name: "podinfo",
    url: "https://github.com/stefanprodan/podinfo",
    kind: "github",
    ref: "",
    credentialId: null,
    ignore: "",
    state: "ready",
    error: null,
    commit: COMMIT,
    fetchedAt: 1,
    files: 364,
    bytes: 1_000_000,
    ignored: 0,
    createdAt: 1,
    updatedAt: 1,
    ...changes,
  };
}

const credential: CredentialSummary = {
  id: "c1",
  name: "github-acme",
  keyName: "http-github",
  key: "set" as CredentialSummary["key"],
  prefix: "https://api.github.com/repos/acme/",
  header: "Authorization",
  template: "Bearer {key}",
  methods: ["GET"],
  projects: [{ id: "p2", name: "platform" }],
  createdAt: 0,
  updatedAt: 0,
};

const team = { projectId: "p2", personal: false };
const personal = { projectId: "p1", personal: true };

let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;
const calls = clientFetch((url, init) => answer(url, init));

beforeEach(() => {
  me.value = null;
  me.value = admin();
  credentials.value = null;
  answer = () => Response.json({ repos: [] });
});

afterEach(() => {
  me.value = undefined;
});

const sent = (i: number) => ({
  url: calls[i]!.url,
  method: calls[i]!.init?.method ?? "GET",
  body:
    calls[i]!.init?.body === undefined
      ? undefined
      : JSON.parse(String(calls[i]!.init?.body)),
});

const held = (projectId: string, list: RepoView[]) => {
  repoLists.value = new Map([[projectId, list]]);
};

// every submit button of the HTML sits inside a form
function submitsInForms(html: string): void {
  const submits = (html.match(/type="submit"/g) ?? []).length;
  expect(submits).toBeGreaterThan(0);
  const inForms = html
    .split("<form")
    .slice(1)
    .reduce(
      (n, f) =>
        n + (f.split("</form>")[0]!.match(/type="submit"/g) ?? []).length,
      0,
    );
  expect(inForms).toBe(submits);
}

describe("the words", () => {
  test("a row says its state", () => {
    expect(stateWords(repo({ state: "pending" })).text).toBe(
      "Waiting to fetch",
    );
    expect(stateWords(repo({ state: "fetching" })).text).toBe("Fetching");
    expect(stateWords(repo()).text).toBe("Ready at 3f2a1c9, 364 files");
    expect(stateWords(repo({ files: 1, ignored: 1_200 })).text).toBe(
      "Ready at 3f2a1c9, 1 file, 1,200 ignored",
    );
    const failed = stateWords(repo({ state: "failed", error: "no access" }));
    expect(failed).toEqual({
      text: "Failed: no access",
      short: "Failed",
      bad: true,
    });
  });

  test("the kind is asked only of a team project on another host", () => {
    expect(asksKind("https://github.com/a/b", false)).toBe(false);
    expect(asksKind("https://GitLab.com/a/b", false)).toBe(false);
    expect(asksKind("https://git.corp.dev/a/b", false)).toBe(true);
    expect(asksKind("https://git.corp.dev/a/b", true)).toBe(false);
    expect(asksKind("git.corp.dev/a/b", false)).toBe(false);
  });

  test("the name's placeholder is the URL's last segment", () => {
    expect(nameOf("https://github.com/stefanprodan/podinfo.git")).toBe(
      "podinfo",
    );
    expect(nameOf("https://gitlab.com/g/sub/My_Repo.v2")).toBe("my_repo-v2");
    expect(nameOf("not a url")).toBe("");
  });

  test("the ignore placeholder is the default list", () => {
    expect(IGNORE_PLACEHOLDER.split("\n")).toEqual([...DEFAULT_REPO_IGNORE]);
  });

  test("a server refusal finds its field", () => {
    expect(repoFieldOf("ignore line 3: unclosed [")).toBe("ignore");
    expect(repoFieldOf("url must be https")).toBe("url");
    expect(
      repoFieldOf(
        "a personal project's repository must be on github.com or gitlab.com",
      ),
    ).toBe("url");
    expect(repoFieldOf("a repository named podinfo exists")).toBe("name");
    expect(repoFieldOf("kind is required for git.corp.dev")).toBe("kind");
    expect(repoFieldOf("ref must be at most 200 characters")).toBe("ref");
    expect(repoFieldOf("credential gh is not bound to this project")).toBe(
      "credentialId",
    );
    expect(repoFieldOf("no such credential")).toBe("credentialId");
    expect(
      repoFieldOf("a project holds at most 10 repositories"),
    ).toBeUndefined();
  });

  test("credentials are those bound to the project, after None", () => {
    const other = { ...credential, id: "c2", name: "other", projects: [] };
    const all = [credential, other];
    expect(credentialOptions(all, "p2", "").map((o) => o.value)).toEqual([
      "",
      "c1",
    ]);
    // a saved one since unbound stays, so the draft shows it
    expect(credentialOptions(all, "p2", "c2").at(-1)).toMatchObject({
      value: "c2",
      label: "other",
    });
  });
});

describe("the bodies", () => {
  test("a create sends only what was typed", () => {
    expect(
      createBody({ ...draftOf(null), url: " https://github.com/a/b " }, false),
    ).toEqual({ url: "https://github.com/a/b" });
    expect(
      createBody(
        {
          url: "https://git.corp.dev/a/b",
          name: "b",
          ref: "main",
          kind: "gitlab",
          credentialId: "c1",
          ignore: "/*\n!/charts/\n",
        },
        false,
      ),
    ).toEqual({
      url: "https://git.corp.dev/a/b",
      name: "b",
      ref: "main",
      kind: "gitlab",
      credentialId: "c1",
      ignore: "/*\n!/charts/\n",
    });
  });

  test("a personal create carries no credential and no kind", () => {
    const body = createBody(
      {
        ...draftOf(null),
        url: "https://git.corp.dev/a/b",
        kind: "github",
        credentialId: "c1",
      },
      true,
    );
    expect(body).toEqual({ url: "https://git.corp.dev/a/b" });
  });

  test("a change sends only what changed", () => {
    const row = repo({ credentialId: "c1", ignore: "*.md" });
    expect(patchBody(draftOf(row), row, false)).toBeNull();
    expect(patchBody({ ...draftOf(row), name: "info" }, row, false)).toEqual({
      name: "info",
    });
    expect(
      patchBody(
        { ...draftOf(row), credentialId: "", ignore: "  ", ref: "v6" },
        row,
        false,
      ),
    ).toEqual({ credentialId: null, ignore: "", ref: "v6" });
    // an emptied name keeps the saved one
    expect(patchBody({ ...draftOf(row), name: "" }, row, false)).toBeNull();
  });
});

describe("the entity", () => {
  test.serial("lists, adds, changes, refreshes and deletes", async () => {
    const row = repo();
    answer = (url, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return Response.json({ repos: [row] });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(
        { repo: url.endsWith("/refresh") ? { ...row, state: "pending" } : row },
        { status: method === "POST" ? 201 : 200 },
      );
    };
    await loadRepos("p2");
    expect(reposOf("p2")).toEqual([row]);
    await addRepo(team, { url: row.url });
    await changeRepo(team, "r1", { name: "info" });
    await refreshRepo(team, "r1");
    expect(reposOf("p2")?.[0]?.state).toBe("pending");
    await deleteRepo(team, "r1");
    expect(reposOf("p2")).toEqual([]);
    expect(calls.map((_, i) => `${sent(i).method} ${sent(i).url}`)).toEqual([
      "GET /api/projects/p2/repos",
      "POST /api/projects/p2/repos",
      "PATCH /api/projects/p2/repos/r1",
      "POST /api/projects/p2/repos/r1/refresh",
      "DELETE /api/projects/p2/repos/r1",
    ]);
    expect(sent(2).body).toEqual({ name: "info" });
  });

  test.serial("a personal project writes under the profile", async () => {
    const row = repo();
    answer = (_url, init) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ repo: row });
    await addRepo(personal, { url: row.url });
    await changeRepo(personal, "r1", { ref: "main" });
    await refreshRepo(personal, "r1");
    await deleteRepo(personal, "r1");
    expect(calls.map((_, i) => `${sent(i).method} ${sent(i).url}`)).toEqual([
      "POST /api/profile/project/repos",
      "PATCH /api/profile/project/repos/r1",
      "POST /api/profile/project/repos/r1/refresh",
      "DELETE /api/profile/project/repos/r1",
    ]);
    expect(reposOf("p1")).toEqual([]);
  });

  test.serial("a failed list says why, and a delete gone is done", async () => {
    answer = () => Response.json({ error: "no such project" }, { status: 404 });
    await loadRepos("p9");
    expect(repoErrorOf("p9")?.words).toBe("no such project");
    held("p2", [repo()]);
    await deleteRepo(team, "r1");
    expect(reposOf("p2")).toEqual([]);
  });

  test.serial("reads again only while a row waits or fetches", async () => {
    const tab = pollTab(REPO_POLL_MS);
    held("p2", [repo()]);
    const stop = watchRepos("p2", tab.tab);
    expect(tab.timers()).toBe(0);
    held("p2", [repo({ state: "pending" })]);
    expect(tab.timers()).toBe(1);
    let state: RepoView["state"] = "fetching";
    answer = () => Response.json({ repos: [repo({ state })] });
    tab.tick();
    await settle();
    expect(calls.length).toBe(1);
    expect(reposOf("p2")?.[0]?.state).toBe("fetching");
    expect(tab.timers()).toBe(1);
    // a hidden tab asks nothing
    tab.set("hidden");
    expect(tab.timers()).toBe(0);
    tab.set("visible");
    state = "ready";
    tab.tick();
    await settle();
    expect(reposOf("p2")?.[0]?.state).toBe("ready");
    expect(tab.timers()).toBe(0);
    stop();
    expect(tab.listeners()).toBe(0);
  });
});

describe("the list", () => {
  test.serial("a team project's card lists each row's state", () => {
    held("p2", [
      repo(),
      repo({
        id: "r2",
        name: "flux2",
        url: "https://git.corp.dev/fluxcd/flux2",
        ref: "v2.4.0",
        state: "failed",
        error: "not found",
      }),
      repo({ id: "r3", name: "charts", state: "fetching" }),
    ]);
    const html = render(<Repos projectId="p2" personal={false} />);
    expect(html).toContain(">Repositories<");
    expect(html).toContain("Add repository");
    expect(html).toContain("github.com/stefanprodan/podinfo · default branch");
    expect(html).toContain("git.corp.dev/fluxcd/flux2 · v2.4.0");
    expect(html).toContain("Ready at 3f2a1c9, 364 files");
    expect(html).toContain("Failed: not found");
    expect(html).toContain("Fetching");
    expect(html.match(/>Change</g)).toHaveLength(3);
    expect(html.match(/>Refresh</g)).toHaveLength(3);
    // a row holding buttons is never a link
    expect(html).not.toContain("<a ");
    expect(html).not.toContain(CAP_LINE);
  });

  test.serial("at the cap Add goes and a line says why", () => {
    held(
      "p2",
      Array.from({ length: MAX_REPOS_PER_PROJECT }, (_, i) =>
        repo({ id: `r${i}`, name: `repo-${i}` }),
      ),
    );
    const html = render(<Repos projectId="p2" personal={false} />);
    expect(html).not.toContain("Add repository");
    expect(html).toContain(CAP_LINE);
  });

  test.serial("an empty list says so", () => {
    held("p1", []);
    const html = render(<Repos projectId="p1" personal />);
    expect(html).toContain(PUBLIC_HINT);
    expect(html).toContain("No repositories yet.");
    expect(html).toContain("Add repository");
  });

  test.serial("Add and Change open the form in place", () => {
    held("p2", [repo({ ref: "main", ignore: "*.md\n" })]);
    const adding = render(
      <RepoRows target={team} list={reposOf("p2")} open={signal("new")} />,
    );
    expect(adding).toContain('name="url"');
    expect(adding).toContain(">Add<");
    submitsInForms(adding);
    const changing = render(
      <RepoRows target={team} list={reposOf("p2")} open={signal("r1")} />,
    );
    expect(changing).toContain(
      'value="https://github.com/stefanprodan/podinfo"',
    );
    expect(changing).toContain('value="main"');
    expect(changing).toContain(">Save<");
    expect(changing).toContain(">Delete<");
    expect(changing).toContain(">Cancel<");
    // the row's own buttons give way to the form
    expect(changing).not.toContain(">Change<");
    submitsInForms(changing);
  });
});

describe("the form", () => {
  test.serial("a team form asks the kind and the credential", () => {
    credentials.value = [credential];
    const save = new Save(async () => {});
    const html = render(
      <RepoFields
        draft={{ ...draftOf(null), url: "https://git.corp.dev/acme/tools" }}
        save={save}
        target={team}
        set={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Host"');
    expect(html).toContain(">GitLab<");
    expect(html).toContain(">Credential<");
    expect(html).toContain('placeholder="tools"');
    expect(html).toContain("*.png\n*.jpg");
  });

  test.serial("a personal form has no credential nor kind", () => {
    credentials.value = [credential];
    const html = render(
      <RepoForm
        target={personal}
        row={repo({ url: "https://git.corp.dev/a/b" })}
        onClose={() => {}}
      />,
    );
    expect(html).not.toContain('aria-label="Host"');
    expect(html).not.toContain("Credential");
    submitsInForms(html);
  });

  test.serial("a refusal shows under its field", async () => {
    const save = new Save(
      async () => {
        throw new ApiError(400, "ignore line 3: unclosed [");
      },
      0,
      repoFieldOf,
    );
    await save.run(null);
    const html = render(
      <RepoFields
        draft={{ ...draftOf(null), ignore: "a\nb\n[x" }}
        save={save}
        target={team}
        set={() => {}}
      />,
    );
    expect(html).toMatch(
      /<textarea[^>]*name="ignore"[^>]*aria-invalid="true"[\s\S]*?class="field-error" role="alert">Ignore line 3: unclosed \[/,
    );
    // the hint gives way to the refusal
    expect(html).not.toContain("Replaces the default list.");
  });

  test.serial("Add posts what was typed and closes", async () => {
    let closed = false;
    answer = () => Response.json({ repo: repo() }, { status: 201 });
    held("p2", []);
    const node = (
      <RepoForm
        target={team}
        row={null}
        onClose={() => {
          closed = true;
        }}
      />
    );
    // one render: the input and the form share its draft
    const previous = options.vnode;
    let onInput: ((e: Event) => void) | undefined;
    let onSubmit: ((e: Event) => void) | undefined;
    options.vnode = (v) => {
      previous?.(v);
      const props = v.props as Record<string, unknown>;
      if (v.type === "input" && props.name === "url") {
        onInput = props.onInput as (e: Event) => void;
      }
      if (v.type === "form") onSubmit = props.onSubmit as (e: Event) => void;
    };
    try {
      render(node);
    } finally {
      options.vnode = previous;
    }
    onInput?.({
      currentTarget: { value: "https://github.com/stefanprodan/podinfo" },
    } as unknown as Event);
    onSubmit?.(new Event("submit", { cancelable: true }));
    await settle();
    expect(sent(0)).toEqual({
      url: "/api/projects/p2/repos",
      method: "POST",
      body: { url: "https://github.com/stefanprodan/podinfo" },
    });
    expect(closed).toBe(true);
    expect(reposOf("p2")).toEqual([repo()]);
  });
});
