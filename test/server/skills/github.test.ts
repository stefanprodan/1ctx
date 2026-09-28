// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  commitUrl,
  fetchGithubFolder,
  rawUrl,
  treeUrl,
} from "../../../src/server/skills/github.ts";
import { MAX_FILES } from "../../../src/server/skills/limits.ts";
import { resolve } from "../../../src/server/skills/source.ts";

const recorded = readFileSync(
  join(
    import.meta.dir,
    "..",
    "..",
    "fixtures",
    "skills",
    "github-visualize.tree.json",
  ),
  "utf8",
);
const sha = "059f5bab7c1da0497a42ee1bb375c2ab70e4549c";
const folder = {
  owner: "stefanprodan",
  repo: "1ctx",
  ref: "main",
  path: "skills/visualize",
};
const signal = () => new AbortController().signal;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

type Answer = () => Response | Promise<Response>;

// answers the given URLs and records every URL asked; any other fails
function recorder(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const fetcher = (async (input) => {
    const url = String(input);
    asked.push(url);
    const answer = answers[url];
    if (answer === undefined) throw new TypeError("unable to connect");
    return answer();
  }) as typeof fetch;
  return { fetcher, asked };
}

type Item = { path: string; mode?: string; type?: string; size?: number };
const tree =
  (items: Item[], truncated = false) =>
  () =>
    new Response(
      JSON.stringify({
        truncated,
        tree: items.map((item) => ({
          mode: "100644",
          type: "blob",
          size: 1,
          ...item,
        })),
      }),
    );
const pinned = { [commitUrl(folder)]: () => new Response(`${sha}\n`) };
const raw = (path: string, body: string) => ({
  [rawUrl(folder, sha, `skills/visualize/${path}`)]: () => new Response(body),
});

describe("fetchGithubFolder", () => {
  test("reads the recorded folder by one commit, never the repo", async () => {
    const listed = JSON.parse(recorded).tree.filter(
      (item: { type: string }) => item.type === "blob",
    ) as { path: string; size: number }[];
    const { fetcher, asked } = recorder({
      ...pinned,
      [treeUrl(folder, sha)]: () => new Response(recorded),
      ...Object.fromEntries(
        listed.map((item) => [
          rawUrl(folder, sha, `skills/visualize/${item.path}`),
          () => new Response("x".repeat(item.size)),
        ]),
      ),
    });
    const got = await fetchGithubFolder(fetcher, folder, signal());
    expect(got.skillMd.byteLength).toBe(11345);
    expect([...got.files.keys()].sort()).toEqual(
      listed
        .map((item) => item.path)
        .filter((path) => path !== "SKILL.md")
        .sort(),
    );
    expect(asked.filter((url) => url.includes("api.github.com"))).toEqual([
      commitUrl(folder),
      treeUrl(folder, sha),
    ]);
  });

  test("leaves submodules and symlinks out as GitHub lists them", async () => {
    const { fetcher, asked } = recorder({
      ...pinned,
      [treeUrl(folder, sha)]: tree([
        { path: "SKILL.md", size: bytes("md") },
        { path: "link", mode: "120000", size: 4 },
        { path: "vendor", mode: "160000", type: "commit" },
      ]),
      ...raw("SKILL.md", "md"),
    });
    const got = await fetchGithubFolder(fetcher, folder, signal());
    expect([...got.files.keys()]).toEqual([]);
    expect(asked.some((url) => url.endsWith("/link"))).toBe(false);
    expect(asked.some((url) => url.endsWith("/vendor"))).toBe(false);
  });

  test.each([
    [
      "too many files",
      tree(
        Array.from({ length: MAX_FILES + 2 }, (_, i) => ({ path: `f${i}.md` })),
      ),
    ],
    ["too large to list", tree([{ path: "SKILL.md" }], true)],
    ["no SKILL.md", tree([{ path: "README.md" }])],
    ["invalid folder listing", tree([{ path: "../SKILL.md" }])],
  ])("refuses %s before reading any file", async (words, answer) => {
    const { fetcher, asked } = recorder({
      ...pinned,
      [treeUrl(folder, sha)]: answer,
    });
    await expect(fetchGithubFolder(fetcher, folder, signal())).rejects.toThrow(
      words,
    );
    expect(asked).toHaveLength(2);
  });

  test("names a missing repo, a missing folder and the request limit", async () => {
    const missing = recorder({
      [commitUrl(folder)]: () => new Response("", { status: 404 }),
    });
    await expect(
      fetchGithubFolder(missing.fetcher, folder, signal()),
    ).rejects.toThrow("GitHub has no stefanprodan/1ctx at main");

    const gone = recorder({
      ...pinned,
      [treeUrl(folder, sha)]: () => new Response("", { status: 404 }),
    });
    await expect(
      fetchGithubFolder(gone.fetcher, folder, signal()),
    ).rejects.toThrow("GitHub has no folder skills/visualize at main");

    const limited = recorder({
      [commitUrl(folder)]: () =>
        new Response("", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
    });
    await expect(
      fetchGithubFolder(limited.fetcher, folder, signal()),
    ).rejects.toThrow("api.github.com limits requests");
  });

  test("a file larger than listed is refused", async () => {
    const { fetcher } = recorder({
      ...pinned,
      [treeUrl(folder, sha)]: tree([{ path: "SKILL.md", size: 2 }]),
      ...raw("SKILL.md", "longer than listed"),
    });
    await expect(fetchGithubFolder(fetcher, folder, signal())).rejects.toThrow(
      "too large",
    );
  });

  test("a failed read stops the others in its batch", async () => {
    const answers: Record<string, Answer> = {
      ...pinned,
      [treeUrl(folder, sha)]: tree([
        { path: "SKILL.md", size: 2 },
        { path: "a.md" },
        { path: "b.md" },
      ]),
      ...raw("SKILL.md", "md"),
      [rawUrl(folder, sha, "skills/visualize/a.md")]: () =>
        new Response("", { status: 500 }),
    };
    let stopped = false;
    const fetcher = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/b.md")) {
        // answers only by being stopped
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            stopped = true;
            reject(new Error("stopped"));
          });
        });
      }
      const answer = answers[url];
      if (answer === undefined) throw new TypeError("unable to connect");
      return answer();
    }) as typeof fetch;
    await expect(fetchGithubFolder(fetcher, folder, signal())).rejects.toThrow(
      "answered 500",
    );
    expect(stopped).toBe(true);
  });
});

describe("fetchGithubFolder deadlines", () => {
  const hang = (async (_input, init) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("stopped")),
      );
    })) as typeof fetch;

  test("a folder past its deadline says GitHub took too long", async () => {
    await expect(fetchGithubFolder(hang, folder, signal(), 20)).rejects.toThrow(
      "GitHub took too long",
    );
  });

  test("a shutdown stays a shutdown", async () => {
    const shutdown = new AbortController();
    const read = fetchGithubFolder(hang, folder, shutdown.signal);
    shutdown.abort();
    await expect(read).rejects.toThrow("server is shutting down");
  });

  test("GitHub's secondary limit is named too", async () => {
    const { fetcher } = recorder({
      [commitUrl(folder)]: () =>
        new Response("", { status: 429, headers: { "retry-after": "60" } }),
    });
    await expect(fetchGithubFolder(fetcher, folder, signal())).rejects.toThrow(
      "limits requests",
    );
  });
});

describe("GitHub URLs", () => {
  test("a pasted escape is decoded once and encoded once", () => {
    const source = resolve(
      "https://github.com/acme/repo/tree/v1.0/a%20b/c%23d",
    );
    expect(source.github).toEqual({
      owner: "acme",
      repo: "repo",
      ref: "v1.0",
      path: "a b/c#d",
    });
    const odd = source.github!;
    expect(commitUrl(odd)).toBe(
      "https://api.github.com/repos/acme/repo/commits/v1.0",
    );
    expect(treeUrl(odd, sha)).toBe(
      `https://api.github.com/repos/acme/repo/git/trees/${sha}:a%20b/c%23d?recursive=1`,
    );
    expect(rawUrl(odd, sha, "a b/c#d/SKILL.md")).toBe(
      `https://raw.githubusercontent.com/acme/repo/${sha}/a%20b/c%23d/SKILL.md`,
    );
  });

  test("refuses a path that climbs out", () => {
    expect(() =>
      resolve("https://github.com/acme/repo/tree/main/a%2F..%2Fb"),
    ).toThrow("GitHub path is invalid");
  });
});
