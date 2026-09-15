// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The skills page's model: the form's kind from the URL and what its
// button says, the head's words, the source and change words, the
// bytes and the cut; the entity that loads the list and folds a write
// back, keeping a body until a refresh; the rail entry; and the page
// rendered over the rows.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { railRows } from "../../../src/client/app/routes.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  addSkill,
  bodies,
  deleteSkill,
  discoverSkills,
  fileKey,
  files,
  loadSkills,
  readSkill,
  readSkillFile,
  refreshSkill,
  skills,
  skillsError,
} from "../../../src/client/data/skills.ts";
import { SkillForm } from "../../../src/client/views/admin/SkillForm.tsx";
import {
  bytesWord,
  changeLine,
  cutLines,
  droppedLine,
  formKind,
  metadataLines,
  metaLine,
  pathProblem,
  sourceLine,
  submitLabel,
  urlProblem,
} from "../../../src/client/views/admin/Skills.model.ts";
import { Skills } from "../../../src/client/views/admin/Skills.tsx";
import type { SkillSummary } from "../../../src/shared/contracts/skill.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

const admin: Me = {
  id: "u1",
  username: "admin",
  fullName: "Stefan Prodan",
  role: "admin",
  mustChangePassword: false,
};

const HOUR = 3_600_000;
const now = 1_789_000_000_000;

const skill = (changes: Partial<SkillSummary>): SkillSummary => ({
  id: "s1",
  name: "timoni",
  description:
    "Use when deploying applications to Kubernetes with Timoni. Covers bundles.",
  license: "Apache-2.0",
  compatibility: "",
  metadata: { version: "1.0", author: "stefanprodan" },
  allowedTools: "",
  sourceKind: "index",
  sourceUrl: "https://timoni.sh",
  sourceSelect: "timoni",
  sourceDigest: "sha256:abc",
  digest: "0123456789abcdef0123",
  bodyBytes: 23_111,
  files: [],
  dropped: [],
  droppedMore: 0,
  fetchedAt: now - 2 * HOUR,
  lastChange: null,
  refreshError: null,
  refreshFailedAt: null,
  agents: ["sre"],
  createdAt: now - 3 * HOUR,
  ...changes,
});
const timoni = skill({});
const gitops = skill({
  id: "s2",
  name: "gitops-knowledge",
  description: "Flux CD and Flux Operator expert. Use for Flux questions.",
  sourceKind: "github",
  sourceUrl:
    "https://github.com/fluxcd/agent-skills/tree/main/skills/gitops-knowledge",
  sourceSelect: "skills/gitops-knowledge",
  sourceDigest: "",
  files: [
    { path: "references/helmrelease.md", bytes: 37_000 },
    { path: "evals/evals.json", bytes: 612 },
  ],
  dropped: [{ path: "assets/logo.png", reason: "binary" }],
  agents: [],
});

const realFetch = globalThis.fetch;
let answer: (url: string, init?: RequestInit) => Response;

beforeEach(() => {
  me.value = admin;
  skills.value = null;
  skillsError.value = null;
  bodies.value = {};
  files.value = {};
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    answer(url, init)) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the form", () => {
  test("tells the four forms apart on the URL alone", () => {
    expect(formKind("https://github.com/o/r/tree/main/skills/x")).toBe(
      "github",
    );
    expect(formKind("https://example.com/skill.tar.gz")).toBe("archive");
    expect(formKind("https://timoni.sh")).toBe("index");
    expect(formKind("https://timoni.sh/.well-known/index.json")).toBe("index");
    expect(formKind("https://timoni.sh/skills/timoni/SKILL.md")).toBe("file");
    expect(formKind("ftp://x")).toBeNull();
    expect(formKind("not a url")).toBeNull();
    expect(submitLabel("index")).toBe("Look up");
    expect(submitLabel("github")).toBe("Add skill");
    expect(submitLabel(null)).toBe("Add skill");
  });

  test("refuses an empty or odd URL and a climbing path", () => {
    expect(urlProblem("")).toBe("Paste a URL");
    expect(urlProblem("x")).toBe("Not an http(s) URL");
    expect(urlProblem("https://timoni.sh")).toBeNull();
    expect(pathProblem("")).toBeNull();
    expect(pathProblem("skills/x")).toBeNull();
    expect(pathProblem("/abs")).toBe("A relative path");
    expect(pathProblem("a/../b")).toBe("A path inside the archive");
  });
});

describe("the row's words", () => {
  test("the head: the files and the fetch, or the failure", () => {
    expect(metaLine(timoni, now)).toEqual({
      text: "fetched 2h ago",
      bad: false,
    });
    expect(metaLine(gitops, now)).toEqual({
      text: "2 files · fetched 2h ago",
      bad: false,
    });
    expect(
      metaLine(
        skill({ refreshError: "timoni.sh answered 502", refreshFailedAt: now }),
        now,
      ),
    ).toEqual({ text: "Refresh failed 0s ago", bad: true });
  });

  test("the source and the change", () => {
    expect(sourceLine(timoni)).toBe("timoni.sh, digest checked");
    expect(sourceLine(gitops)).toBe("GitHub, main, skills/gitops-knowledge");
    expect(
      sourceLine(
        skill({
          sourceKind: "archive",
          sourceUrl: "https://x.dev/s.tgz",
          sourceSelect: "",
        }),
      ),
    ).toBe("Archive, at its root");
    expect(
      sourceLine(
        skill({
          sourceKind: "file",
          sourceUrl: "https://x.dev/SKILL.md",
          sourceSelect: "",
        }),
      ),
    ).toBe("Raw SKILL.md");
    expect(changeLine(null, timoni.fetchedAt, timoni.createdAt)).toMatch(
      /^Same as \d+ /,
    );
    // the last change is older than the latest fetch: nothing new
    expect(
      changeLine(
        {
          at: now - 5 * HOUR,
          body: true,
          description: false,
          fields: [],
          files: { added: [], removed: [], changed: [] },
        },
        now - HOUR,
        timoni.createdAt,
      ),
    ).toMatch(/^Same as \d+ /);
    expect(
      changeLine(
        {
          at: now,
          body: true,
          description: false,
          fields: ["license"],
          files: { added: ["a", "b"], removed: ["c"], changed: [] },
        },
        timoni.fetchedAt,
        timoni.createdAt,
      ),
    ).toMatch(/^Body changed, license changed, 2 files added, 1 file removed/);
  });

  test("the bytes, the dropped files, the metadata and the cut", () => {
    expect(bytesWord(612)).toBe("612 B");
    expect(bytesWord(37_000)).toBe("36.1 KB");
    expect(bytesWord(2 * 1024 * 1024)).toBe("2 MB");
    expect(droppedLine(timoni)).toBe("");
    expect(droppedLine(gitops)).toBe(
      "1 file not kept: assets/logo.png (binary)",
    );
    expect(droppedLine({ ...gitops, droppedMore: 12 })).toBe(
      "13 files not kept: assets/logo.png (binary) and 12 more",
    );
    expect(metadataLines(timoni.metadata)).toEqual([
      "author: stefanprodan",
      "version: 1.0",
    ]);
    const long = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n");
    expect(cutLines(long, 3)).toEqual({
      text: "line 0\nline 1\nline 2",
      more: true,
    });
    expect(cutLines("one", 3)).toEqual({ text: "one", more: false });
  });
});

describe("the skills entity", () => {
  test("loads the list in name order and keeps a failure", async () => {
    answer = () => Response.json({ skills: [timoni, gitops] });
    await loadSkills();
    expect(skills.value?.map((s) => s.name)).toEqual([
      "gitops-knowledge",
      "timoni",
    ]);
    answer = () => Response.json({ error: "nope" }, { status: 500 });
    await loadSkills();
    expect(skillsError.value).toBe("nope");
  });

  test("a write folds the row and its body back, a refresh drops the files held", async () => {
    skills.value = [gitops];
    const calls: { url: string; method?: string; body?: string }[] = [];
    answer = (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body as string });
      if (url === "/api/skills/discover") {
        return Response.json({
          url: "https://timoni.sh/.well-known/agent-skills/index.json",
          entries: [
            {
              name: "timoni",
              type: "skill-md",
              description: "x",
              url: "https://timoni.sh/x/SKILL.md",
              digest: "sha256:abc",
            },
          ],
        });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url === "/api/skills/s2/file?path=evals%2Fevals.json") {
        return Response.json({
          path: "evals/evals.json",
          content: "{}",
          bytes: 2,
        });
      }
      if (url === "/api/skills/s2/refresh") {
        return Response.json({
          skill: { ...gitops, bodyBytes: 9 },
          body: "new",
        });
      }
      return Response.json({ skill: timoni, body: "# Timoni" });
    };
    const entries = await discoverSkills("https://timoni.sh");
    expect(entries[0]?.name).toBe("timoni");
    expect(calls[0]).toMatchObject({
      url: "/api/skills/discover",
      method: "POST",
      body: '{"url":"https://timoni.sh"}',
    });
    await addSkill({
      url: "https://timoni.sh",
      name: "timoni",
      digest: "sha256:abc",
    });
    expect(skills.value?.map((s) => s.name)).toEqual([
      "gitops-knowledge",
      "timoni",
    ]);
    expect(bodies.value.s1).toBe("# Timoni");
    // held, so no second call
    expect(await readSkill("s1")).toBe("# Timoni");
    expect(await readSkillFile("s2", "evals/evals.json")).toBe("{}");
    expect(files.value[fileKey("s2", "evals/evals.json")]).toBe("{}");
    await refreshSkill("s2");
    expect(skills.value?.find((s) => s.id === "s2")?.bodyBytes).toBe(9);
    expect(bodies.value.s2).toBe("new");
    expect(files.value[fileKey("s2", "evals/evals.json")]).toBeUndefined();
    await deleteSkill("s1");
    expect(skills.value?.map((s) => s.id)).toEqual(["s2"]);
    expect(bodies.value.s1).toBeUndefined();
    expect(
      Object.keys(files.value).some((key) => key.startsWith("s1\n")),
    ).toBeFalse();
    expect(calls.map((c) => c.method ?? "GET")).toEqual([
      "POST",
      "POST",
      "GET",
      "POST",
      "DELETE",
    ]);
  });

  test("the entities go with the signed-in user", () => {
    skills.value = [timoni];
    bodies.value = { s1: "x" };
    me.value = { ...admin, id: "u2" };
    expect(skills.value).toBeNull();
    expect(bodies.value).toEqual({});
  });
});

describe("the page", () => {
  test("sits in the Admin group after Tools", () => {
    const group = railRows("admin").find((r) => r.kind === "group");
    const labels =
      group?.kind === "group" ? group.routes.map((r) => r.nav!.label) : [];
    expect(labels).toEqual(["Projects", "Users", "Agents", "Tools", "Skills"]);
  });

  test("renders the rows with their heads and the empty note", () => {
    skills.value = [gitops, timoni];
    const html = render(<Skills />);
    expect(html).toContain("gitops-knowledge");
    expect(html).toContain("Flux CD and Flux Operator expert.");
    expect(html).toContain("2 files · fetched");
    expect(html).toContain("Add skill");
    expect(html).not.toContain("rows-meta-bad");
    skills.value = [];
    expect(render(<Skills />)).toContain("No skills yet");
  });

  test("the form asks for a URL and names the four forms", () => {
    skills.value = [];
    const html = render(<SkillForm onDone={() => {}} />);
    expect(html).toContain('name="url"');
    expect(html).toContain("a GitHub directory, a raw SKILL.md, or a tarball");
    expect(html).toContain("Add skill");
    expect(html).not.toContain('name="path"');
  });

  test("says it is loading, then the failure", () => {
    expect(render(<Skills />)).toContain("Loading");
    skillsError.value = "the server did not answer";
    expect(render(<Skills />)).toContain("the server did not answer");
  });
});
