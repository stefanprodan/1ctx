// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path } from "../../../src/client/app/router.ts";
import { agents } from "../../../src/client/data/agents.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  addSkill,
  allSkillUsage,
  bodies,
  deleteSkill,
  discoverSkills,
  fileKey,
  files,
  loadAllSkillUsage,
  loadSkills,
  loadSkillUsage,
  readSkill,
  readSkillFile,
  refreshSkill,
  skills,
  skillsError,
  skillUsage,
} from "../../../src/client/data/skills.ts";
import { NewSkill } from "../../../src/client/views/admin/NewSkill.tsx";
import { SkillList } from "../../../src/client/views/admin/SkillList.tsx";
import {
  SkillPage,
  skillTabOf,
} from "../../../src/client/views/admin/SkillPage.tsx";
import {
  carriersOf,
  changeLine,
  droppedLine,
  formKind,
  metadataLines,
  pathProblem,
  skillDeleteLine,
  sourceLine,
  submitLabel,
  textBox,
  urlProblem,
} from "../../../src/client/views/admin/Skills.model.ts";
import type { AgentSummary } from "../../../src/shared/contracts/agent.ts";
import type { SkillSummary } from "../../../src/shared/contracts/skill.ts";
import { clientFetch } from "../../helpers/client-fetch.ts";
import { admin as adminFixture } from "../../helpers/client-fixtures.ts";

const admin = adminFixture();

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

let answer: (url: string, init?: RequestInit) => Response;
clientFetch((url, init) => answer(url, init));

beforeEach(() => {
  // a new sign-in drops the usage answers
  me.value = null;
  me.value = admin;
  skills.value = null;
  skillsError.value = null;
  bodies.value = {};
  files.value = {};
});

describe("the form", () => {
  test.serial("the detected form picks Look up or Add skill", () => {
    expect(formKind("https://timoni.sh")).toBe("index");
    expect(formKind("ftp://x")).toBeNull();
    expect(submitLabel("index")).toBe("Look up");
    expect(submitLabel("github")).toBe("Add skill");
    expect(submitLabel("archive")).toBe("Add skill");
    expect(submitLabel("file")).toBe("Add skill");
    expect(submitLabel(null)).toBe("Add skill");
  });

  test.serial("refuses an empty or odd URL and a climbing path", () => {
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
  test.serial(
    "the text folds at twelve lines and says how many there are",
    () => {
      const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
      const folded = textBox(long, false);
      expect(folded.cut).toBe(true);
      expect(folded.text.split("\n")).toHaveLength(12);
      expect(folded.label).toBe("Show all 20 lines");
      const open = textBox(long, true);
      expect(open.text).toBe(long);
      // open stays open: the row folds it again
      expect(open.label).toBe("Show all 20 lines");
      const short = textBox("one\ntwo\n", false);
      expect(short.cut).toBe(false);
      expect(short.text).toBe("one\ntwo\n");
    },
  );

  test.serial("the source and the change", () => {
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

  test.serial("the bytes, the dropped files and the metadata", () => {
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
  });
});

describe("the skills entity", () => {
  test.serial("loads the list in name order and keeps a failure", async () => {
    answer = () => Response.json({ skills: [timoni, gitops] });
    await loadSkills();
    expect(skills.value?.map((s) => s.name)).toEqual([
      "gitops-knowledge",
      "timoni",
    ]);
    answer = () => Response.json({ error: "nope" }, { status: 500 });
    await loadSkills();
    expect(skillsError.value).toEqual({ words: "nope", status: 500 });
  });

  test.serial(
    "a write folds the row and its body back, a refresh drops the files held",
    async () => {
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
        if (init?.method === "DELETE")
          return new Response(null, { status: 204 });
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
    },
  );

  test.serial(
    "a list load during a body read keeps the body, a refresh does not",
    async () => {
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      answer = (url) => {
        if (url === "/api/skills") return Response.json({ skills: [timoni] });
        if (url === "/api/skills/s1/refresh") {
          return Response.json({ skill: timoni, body: "fresh" });
        }
        return held.then(() =>
          Response.json({ skill: timoni, body: "# Timoni" }),
        ) as unknown as Response;
      };
      // the page's arrival reads the body while its route reloads the list
      const reading = readSkill("s1");
      await loadSkills();
      release();
      await reading;
      expect(bodies.value.s1).toBe("# Timoni");
      bodies.value = {};
      let again: () => void = () => {};
      const second = new Promise<void>((resolve) => {
        again = resolve;
      });
      answer = (url) =>
        url === "/api/skills/s1/refresh"
          ? Response.json({ skill: timoni, body: "fresh" })
          : (second.then(() =>
              Response.json({ skill: timoni, body: "stale" }),
            ) as unknown as Response);
      const stale = readSkill("s1");
      await refreshSkill("s1");
      again();
      await stale;
      expect(bodies.value.s1).toBe("fresh");
    },
  );

  test.serial(
    "a file read a refresh overtook reads again, since the refresh dropped it",
    async () => {
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reads = 0;
      answer = (url) => {
        if (url === "/api/skills/s2/refresh") {
          return Response.json({ skill: gitops, body: "fresh" });
        }
        reads++;
        const content = reads === 1 ? "stale" : "new";
        const body = { path: "evals/evals.json", content, bytes: 3 };
        return (reads === 1
          ? held.then(() => Response.json(body))
          : Response.json(body)) as unknown as Response;
      };
      const reading = readSkillFile("s2", "evals/evals.json");
      await refreshSkill("s2");
      release();
      expect(await reading).toBe("new");
      expect(files.value[fileKey("s2", "evals/evals.json")]).toBe("new");
    },
  );

  test.serial(
    "usage: only the latest read lands, a failure is null",
    async () => {
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const usage = (loads: number) => ({
        since: 0,
        until: 1,
        loads,
        reads: 0,
        failed: 0,
        files: [],
      });
      answer = (url) =>
        url === "/api/skills/s1/usage"
          ? (held.then(() => Response.json(usage(1))) as unknown as Response)
          : Response.json(usage(2));
      // a switch to another skill before the first answer
      const first = loadSkillUsage("s1");
      await loadSkillUsage("s2");
      release();
      await first;
      expect(skillUsage.valueFor("s1")).toEqual(usage(1));
      expect(skillUsage.valueFor("s2")).toEqual(usage(2));
      answer = () => Response.json({ error: "nope" }, { status: 500 });
      expect(allSkillUsage.value()).toBeUndefined();
      await loadAllSkillUsage();
      expect(allSkillUsage.value()).toBeNull();
    },
  );

  test.serial("the entities go with the signed-in user", async () => {
    skills.value = [timoni];
    bodies.value = { s1: "x" };
    answer = () => Response.json({ error: "nope" }, { status: 500 });
    await Promise.all([loadAllSkillUsage(), loadSkillUsage("s1")]);
    expect(skillUsage.valueFor("s1")).toBeNull();
    me.value = { ...admin, id: "u2" };
    expect(skills.value).toBeNull();
    expect(bodies.value).toEqual({});
    expect(allSkillUsage.value()).toBeUndefined();
    expect(skillUsage.valueFor("s1")).toBeUndefined();
  });
});

const agent = (name: string, skillIds: string[]) =>
  ({
    id: `a-${name}`,
    name,
    avatar: "bot",
    skills: skillIds,
    servers: [],
  }) as unknown as AgentSummary;

describe("the list", () => {
  test.serial("a row per skill: its first sentence, agents and files", () => {
    skills.value = [gitops, timoni];
    agents.value = null;
    // the rows count the agents, so the page waits for them
    expect(render(<SkillList />)).not.toContain("gitops-knowledge");
    agents.value = [agent("sre", ["s1"])];
    const html = render(<SkillList />);
    expect(html).toContain('href="/admin/config/skills/gitops-knowledge"');
    expect(html).toContain("Flux CD and Flux Operator expert.");
    expect(html).not.toContain("Use for Flux questions.");
    // SKILL.md counted with the files
    expect(html).toContain("3 files");
    expect(html).toContain("No agents");
    expect(html).toContain("1 agent");
    expect(html).toContain('href="/admin/config/skills?new"');
    expect(html).toContain("Loading");
  });

  test.serial("a failed refresh takes the sentence's place, in red", () => {
    skills.value = [
      { ...gitops, refreshError: "404", refreshFailedAt: Date.now() - 60_000 },
    ];
    agents.value = [];
    const html = render(<SkillList />);
    expect(html).toContain(
      '<span class="rows-sub rows-bad">refresh failed 1m ago',
    );
    skills.value = [];
    expect(render(<SkillList />)).toContain("No skills yet");
  });

  test.serial(
    "the aside has the loads and the most loaded skills",
    async () => {
      skills.value = [gitops];
      agents.value = [];
      answer = () =>
        Response.json({
          since: 0,
          until: 1,
          loads: 7,
          reads: 4,
          failed: 1,
          skills: [
            { name: "gitops-knowledge", loads: 5, reads: 4, failed: 0 },
            { name: "gone", loads: 2, reads: 0, failed: 1 },
            { name: "read-only", loads: 0, reads: 1, failed: 0 },
          ],
        });
      await loadAllSkillUsage();
      const html = render(<SkillList />);
      expect(html).toMatch(/Loads[\s\S]*?7/);
      expect(html).toMatch(/File reads[\s\S]*?4/);
      expect(html).toContain("Most loaded");
      // a deleted skill is named but not linked, one never loaded is left out
      expect(html).toContain("gone");
      expect(html).not.toContain('href="/admin/config/skills/gone"');
      expect(html).not.toContain("read-only");
      expect(html).toContain('href="/admin/monitor/usage"');
      answer = () => Response.json({ error: "nope" }, { status: 500 });
      await loadAllSkillUsage();
      expect(render(<SkillList />)).toContain("Did not load.");
    },
  );
});

describe("Add skill", () => {
  test.serial("asks for a URL and names the four forms", () => {
    skills.value = [];
    const html = render(<NewSkill />);
    expect(html).toContain('name="url"');
    expect(html).toContain(
      "a GitHub directory, a raw SKILL.md, or a zip or tar archive",
    );
    expect(html).toContain("Add skill");
    expect(html).toContain('href="/admin/config/skills"');
    expect(html).not.toContain('name="path"');
    // the submit sits in the form
    expect(html).toMatch(/<form[^>]*>[\s\S]*type="submit"[\s\S]*<\/form>/);
  });
});

describe("a skill's page", () => {
  test.serial("the tab is the step after the name", () => {
    expect(skillTabOf("/admin/config/skills/timoni")).toBe("general");
    expect(skillTabOf("/admin/config/skills/timoni/files")).toBe("files");
    expect(skillTabOf("/admin/config/skills/files")).toBe("general");
  });

  test.serial(
    "General: the facts, the agents that carry it, Delete off",
    () => {
      skills.value = [gitops, timoni];
      agents.value = [agent("sre", ["s1"])];
      path.value = "/admin/config/skills/timoni";
      const html = render(<SkillPage params={{ name: "timoni" }} />);
      expect(html).toContain("Apache-2.0");
      expect(html).toContain("author: stefanprodan\nversion: 1.0");
      expect(html).toContain("timoni.sh, digest checked");
      expect(html).toContain("0123456789ab · Same as");
      expect(html).toContain('href="/admin/config/agents/sre/skills"');
      expect(html).toContain(
        "1 agent carries it. Remove it from that agent first.",
      );
      // the server refuses a skill an agent carries, so Delete waits
      expect(html).toMatch(/<button[^>]*disabled[^>]*>Delete</);
      expect(html).toContain('href="/admin/config/skills/timoni/files"');
    },
  );

  test.serial("General: a failed refresh over the tabs, no agents", () => {
    skills.value = [
      {
        ...timoni,
        refreshError: "the host timoni.sh answered 502",
        refreshFailedAt: Date.now() - 60_000,
        fetchedAt: Date.now() - 2 * HOUR,
      },
    ];
    agents.value = [];
    path.value = "/admin/config/skills/timoni";
    const html = render(<SkillPage params={{ name: "timoni" }} />);
    expect(html).toContain(
      "The host timoni.sh answered 502. Last refresh 1m ago.",
    );
    expect(html).toContain("No agent carries it.");
    expect(html).not.toContain("Used by");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Delete</);
  });

  test.serial("Files: SKILL.md, the files and what was not kept", () => {
    skills.value = [gitops];
    agents.value = [];
    bodies.value = {
      s2: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"),
    };
    path.value = "/admin/config/skills/gitops-knowledge/files";
    const html = render(<SkillPage params={{ name: "gitops-knowledge" }} />);
    expect(html).toContain("SKILL.md");
    expect(html).toMatch(/Show all \d+ lines/);
    expect(html).toContain("references/helmrelease.md");
    expect(html).toContain("1 file not kept: assets/logo.png (binary)");
    expect(html).not.toContain("Delete gitops-knowledge");
  });

  test.serial(
    "the aside has its last 30 days and its most read files",
    async () => {
      skills.value = [gitops];
      agents.value = [];
      path.value = "/admin/config/skills/gitops-knowledge";
      const page = () =>
        render(<SkillPage params={{ name: "gitops-knowledge" }} />);
      expect(page()).toContain("Loading");
      answer = () =>
        Response.json({
          since: 0,
          until: 1,
          loads: 3,
          reads: 2,
          failed: 0,
          files: [{ path: "references/helmrelease.md", reads: 2 }],
        });
      // another skill's answer is not this one's
      await loadSkillUsage("s1");
      expect(page()).toContain("Loading");
      await loadSkillUsage("s2");
      expect(page()).toMatch(/Loads[\s\S]*?3/);
      expect(page()).toContain("Most read");
      expect(page()).toContain('href="/admin/monitor/usage"');
      answer = () => Response.json({ error: "nope" }, { status: 500 });
      await loadSkillUsage("s2");
      expect(page()).toContain("Did not load.");
    },
  );

  test.serial("waits for the agents, so Delete never opens early", () => {
    skills.value = [timoni];
    agents.value = null;
    path.value = "/admin/config/skills/timoni";
    const html = render(<SkillPage params={{ name: "timoni" }} />);
    expect(html).toContain("Loading");
    expect(html).not.toContain("Delete timoni");
  });

  test.serial("an unknown name, and the Delete words", () => {
    skills.value = [timoni];
    agents.value = [];
    expect(render(<SkillPage params={{ name: "nope" }} />)).toContain(
      "No skill by that name.",
    );
    expect(skillDeleteLine(2)).toBe(
      "2 agents carry it. Remove it from them first.",
    );
    const carriers = carriersOf(
      [agent("sre", ["s1"]), agent("dev", ["s2"]), agent("ops", ["s1", "s2"])],
      "s1",
    );
    expect(carriers.map((a) => a.name)).toEqual(["sre", "ops"]);
  });

  test.serial("says it is loading, then the failure", () => {
    agents.value = [];
    expect(render(<SkillList />)).toContain("Loading");
    skillsError.value = { words: "the server did not answer", status: null };
    const html = render(<SkillList />);
    expect(html).toContain("The server did not answer.");
    expect(html).not.toContain("HTTP");
  });
});
