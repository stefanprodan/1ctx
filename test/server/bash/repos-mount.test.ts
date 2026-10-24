// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A repository's tree mounted read-only at /repos/<name> through the
// real command worker, the box on: reads beside scratch, writes refused
// at the command, nothing under /repos ever saved, and the walk and read
// caps grown by what the tree holds.

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryFs } from "just-bash";
import type { CommandCaps } from "../../../src/server/bash/mount.ts";
import type { Job, JobRepo } from "../../../src/server/bash/protocol.ts";
import { executionLimits } from "../../../src/server/bash/tree.ts";
import { callCaps, run, type Setup, scratchState, setup } from "./helpers.ts";

// every command starts a worker and walks a real tree: a loaded CI
// runner takes seconds for what a laptop does at once
setDefaultTimeout(90_000);
const caps: CommandCaps = { ...callCaps, callTimeoutMs: 30_000 };

const DIRS = 30;
const PER_DIR = 40;
const SMALL = `${"x".repeat(99)}\n`;

// a folder per file, as many as the walk's floor and more
const FOLDERS = 1500;
// files one search reads past four passes over a small mount, each
// small enough that holding a few at once stays under the live cap
const LARGE = 160;
const LARGE_BYTES = 64 * 1024;

let base = "";
let tree: JobRepo;
let folders: JobRepo;
let large: JobRepo;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "repos-mount-"));
  const root = join(base, "files");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "# widgets\nneedle\n");
  await writeFile(join(root, "src/a.go"), "package a\n// needle\n");
  await symlink("a.go", join(root, "src/link.go"));
  await writeFile(join(root, "big.bin"), Buffer.alloc(4096, 97));
  for (let d = 0; d < DIRS; d++) {
    await mkdir(join(root, `many/d${d}`), { recursive: true });
    for (let f = 0; f < PER_DIR; f++)
      await writeFile(join(root, `many/d${d}/f${f}`), SMALL);
  }
  tree = {
    name: "widgets",
    folder: root,
    files: 4 + DIRS * PER_DIR,
    dirs: 2 + DIRS,
    bytes: 4096 + 37 + DIRS * PER_DIR * SMALL.length,
  };
  const wide = join(base, "wide");
  for (let d = 0; d < FOLDERS; d++) {
    await mkdir(join(wide, `d${d}`), { recursive: true });
    await writeFile(join(wide, `d${d}/f`), "x\n");
  }
  folders = {
    name: "wide",
    folder: wide,
    files: FOLDERS,
    dirs: FOLDERS,
    bytes: 2 * FOLDERS,
  };
  const heavy = join(base, "large");
  await mkdir(heavy, { recursive: true });
  for (let f = 0; f < LARGE; f++)
    await writeFile(join(heavy, `f${f}`), Buffer.alloc(LARGE_BYTES, 97));
  large = {
    name: "large",
    folder: heavy,
    files: LARGE,
    dirs: 0,
    bytes: LARGE * LARGE_BYTES,
  };
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const withRepos = (
  fields: Partial<JobRepo> = {},
  notice = "",
  given: CommandCaps = caps,
): CommandCaps => ({
  ...given,
  repos: { mounts: [{ ...tree, ...fields }], fileBytes: 2048, notice },
});

const output = async (s: Setup, command: string, caps = withRepos()) =>
  (await run(s, command, caps)).content;

describe("a repository mounted beside scratch", () => {
  test("lists, reads and searches it", async () => {
    const s = setup();
    expect(await output(s, "ls /repos")).toBe("widgets\n\nexit 0");
    expect(await output(s, "ls / | grep -c repos")).toBe("1\n\nexit 0");
    expect(await output(s, "cat /repos/widgets/src/link.go")).toBe(
      "package a\n// needle\n\nexit 0",
    );
    expect(
      await output(s, "cd /repos/widgets && rg -l needle README.md src | sort"),
    ).toBe("README.md\nsrc/a.go\n\nexit 0");
    expect(await output(s, "find /repos/widgets/many -type f | wc -l")).toBe(
      `${DIRS * PER_DIR}\n\nexit 0`,
    );
  });

  test("without a mount there is no /repos", async () => {
    const s = setup();
    expect(await output(s, "ls /repos", caps)).toContain(
      "No such file or directory",
    );
  });

  test("a write fails at the command with Read-only file system", async () => {
    const s = setup();
    const result = await run(
      s,
      "echo x > /repos/widgets/f; rm /repos/widgets/README.md",
      withRepos(),
    );
    expect(result.content).toContain(
      "bash: /repos/widgets/f: Read-only file system",
    );
    expect(result.content).toContain(
      "rm: cannot remove '/repos/widgets/README.md': Read-only file system",
    );
    expect(result.error).toBe(true);
  });

  test("a copy into /tmp saves, and nothing under /repos does", async () => {
    const s = setup();
    const result = await run(
      s,
      "cp /repos/widgets/src/a.go /tmp/a.go && mv /repos/widgets/README.md /tmp/r.md",
      withRepos(),
    );
    expect(result.content).toContain(
      "mv: cannot remove '/repos/widgets/README.md': Read-only file system",
    );
    const saved = scratchState(s).entries.map((entry) => entry.path);
    expect(saved.sort()).toEqual(["a.go", "r.md"]);
    expect(await output(s, "cat /repos/widgets/README.md")).toBe(
      "# widgets\nneedle\n\nexit 0",
    );
  });

  test("a write beside the mounts is discarded with a notice", async () => {
    const s = setup();
    const result = await run(
      s,
      "mkdir -p /repos/mine && echo x > /repos/mine/f && cat /repos/mine/f",
      withRepos(),
    );
    expect(result.content).toBe(
      "changes under /repos were discarded: copy a file to /tmp to change it\nx\n\nexit 0",
    );
    expect(scratchState(s).entries).toEqual([]);
  });

  test("a file past the read limit says File too large", async () => {
    const s = setup();
    expect(await output(s, "cat /repos/widgets/big.bin")).toContain(
      "cat: /repos/widgets/big.bin: File too large",
    );
    expect(await output(s, "ls -l /repos/widgets/big.bin")).toContain("4096");
  });

  test("open shows a repository file and refuses one past the read limit by name", async () => {
    const s = setup();
    const result = await run(s, "open /repos/widgets/README.md", withRepos());
    expect(result.opened?.map((file) => file.path)).toEqual([
      "/repos/widgets/README.md",
    ]);
    expect(await output(s, "open /repos/widgets/big.bin")).toContain(
      "open: /repos/widgets/big.bin: over 2 KB, open a smaller part",
    );
  });

  test("the next command starts where a command left it in a repository", async () => {
    const s = setup();
    await run(s, "cd /repos/widgets/src", withRepos());
    expect(await output(s, "pwd")).toBe("/repos/widgets/src\n\nexit 0");
    expect(await output(s, "pwd", caps)).toBe(
      "started in /knowledge: /repos/widgets/src no longer exists\n/knowledge\n\nexit 0",
    );
  });

  test("a cwd at /repos itself makes no discard notice", async () => {
    const s = setup();
    await run(s, "cd /repos/widgets; cd ..", withRepos());
    expect(await output(s, "pwd")).toBe("/repos\n\nexit 0");
    expect(await output(s, "cd /repos && ls")).toBe("widgets\n\nexit 0");
  });

  test("the result opens with the send's notice", async () => {
    const s = setup();
    expect(
      await output(
        s,
        "ls /repos",
        withRepos({}, "repo charts is unavailable: fetching\n"),
      ),
    ).toBe("repo charts is unavailable: fetching\nwidgets\n\nexit 0");
  });

  test("a folder gone from the cache is left out with a notice", async () => {
    const s = setup();
    expect(
      await output(s, "ls /repos", withRepos({ folder: join(base, "gone") })),
    ).toContain("repo widgets is unavailable: its files are gone\n");
  });
});

describe("the caps grow with the mount", () => {
  const mount = (dirs: number): CommandCaps => ({
    ...caps,
    repos: {
      mounts: [{ ...folders, dirs }],
      fileBytes: 2048,
      notice: "",
    },
  });
  const walks: [string, string][] = [
    ["find /repos/wide -type f | wc -l", `${FOLDERS}`],
    ["rg -c x /repos/wide | wc -l", `${FOLDERS}`],
    ["du -s /repos/wide | cut -f2", "/repos/wide"],
    ["ls -R /repos/wide | grep -c '^f$'", `${FOLDERS}`],
  ];
  for (const [walk, out] of walks) {
    test(`a walk of many folders fits once they count: ${walk}`, async () => {
      const s = setup();
      // one walk proves the cap without the folders; each fits with them
      if (walk.startsWith("find")) {
        expect((await run(s, walk, mount(0))).content).toContain("exit 126");
      }
      expect((await run(s, walk, mount(FOLDERS))).content).toBe(
        `${out}\n\nexit 0`,
      );
    });
  }

  test("a walk of the whole tree fits once its files count", async () => {
    const s = setup();
    const walk = "find /repos/widgets | wc -l";
    expect((await run(s, walk, withRepos({ files: 0 }))).content).toContain(
      "entry limit exceeded",
    );
    expect(await output(s, walk)).toBe(
      `${DIRS * PER_DIR + DIRS + 7}\n\nexit 0`,
    );
  });

  test("a search of the whole tree fits once its bytes count", async () => {
    // a mount of about 2 MiB, so four passes over it are less than one
    // search of the tree reads
    const s = setup({
      knowledgeProjectBytes: 1000,
      scratchBytes: 1000,
      uploadBytes: 1000,
      knowledgeFileBytes: 1000,
    });
    const mount = (bytes: number): CommandCaps => ({
      ...caps,
      repos: {
        mounts: [{ ...large, bytes }],
        fileBytes: LARGE_BYTES,
        notice: "",
      },
    });
    // no match, so every file is read
    const search = "echo x > /tmp/kept; rg -q zzz /repos/large; echo $?";
    const refused = await run(s, search, mount(0));
    expect(refused.content).toContain("input size limit exceeded");
    expect(refused.content).toContain("nothing saved");
    expect(refused.content).toEndWith("exit 126");
    expect(scratchState(s).entries).toEqual([]);
    expect((await run(s, search, mount(large.bytes))).content).toBe(
      "1\n\nexit 0",
    );
  });

  test("searches of a repository may read past the old cap", async () => {
    // the old cap was one read of the base plus one pass over the tree
    const s = setup({ scratchBytes: 1000, knowledgeFileBytes: 1000 });
    const search = "rg -q zzz /repos/widgets/many; echo $?";
    expect(await output(s, [search, search, search].join("; "))).toBe(
      "1\n1\n1\n\nexit 0",
    );
  });

  test("searches of the knowledge base alone may read past the old cap", async () => {
    const s = setup({ scratchBytes: 1000, knowledgeFileBytes: 1000 });
    // each pass reads more than the old cap, one read of the base
    for (let f = 0; f < 10; f++)
      s.knowledge.create(s.projectId, s.author, `k${f}.md`, "x".repeat(900));
    const search = "rg -q zzz /knowledge; echo $?";
    expect(await output(s, [search, search, search].join("; "), caps)).toBe(
      "1\n1\n1\n\nexit 0",
    );
  });
});

describe("the input cap", () => {
  const job = (repos: JobRepo[]) =>
    ({ ioBytes: 4000, mountBytes: 1_000_000, iterations: 10, repos }) as Job;

  test("is four passes over everything mounted", () => {
    const fs = new InMemoryFs();
    expect(executionLimits(job([]), fs, 1000).maxInputBytes).toBe(4_000_000);
    const repo = { ...tree, bytes: 250_000 };
    expect(executionLimits(job([repo, repo]), fs, 1000).maxInputBytes).toBe(
      6_000_000,
    );
  });
});
