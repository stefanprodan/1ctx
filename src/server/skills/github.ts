// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { BadGateway, BadRequest, ServiceUnavailable } from "../lib/errors.ts";
import { validPath } from "../lib/paths.ts";
import { download, fetchText } from "./fetch.ts";
import {
  FETCH_DEADLINE_MS,
  MAX_ARCHIVE_MEMBERS,
  MAX_FILES,
  MAX_INDEX_BYTES,
  MAX_TAR_BYTES,
} from "./limits.ts";
import type { Picked } from "./source.ts";

export type GithubFolder = {
  owner: string;
  repo: string;
  ref: string;
  path: string;
};

type Blob = { path: string; size: number };

const API = "https://api.github.com/repos";
const JSON_ACCEPT = { accept: "application/vnd.github+json" };
const SHA_ACCEPT = { accept: "application/vnd.github.sha" };
// a few reads at a time, so a skill of 200 files is not 200 at once
const PARALLEL = 6;
// git modes the archive reader would not keep either
const SYMLINK = "120000";

const segments = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");
const repoUrl = (f: GithubFolder) =>
  `${API}/${encodeURIComponent(f.owner)}/${encodeURIComponent(f.repo)}`;

export function commitUrl(folder: GithubFolder): string {
  return `${repoUrl(folder)}/commits/${encodeURIComponent(folder.ref)}`;
}

export function treeUrl(folder: GithubFolder, commit: string): string {
  return `${repoUrl(folder)}/git/trees/${commit}:${segments(folder.path)}?recursive=1`;
}

export function rawUrl(
  folder: GithubFolder,
  commit: string,
  path: string,
): string {
  return `https://raw.githubusercontent.com/${encodeURIComponent(folder.owner)}/${encodeURIComponent(folder.repo)}/${commit}/${segments(path)}`;
}

function blobs(text: string): Blob[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRequest("GitHub answered with no folder listing");
  }
  const tree = (parsed as { tree?: unknown })?.tree;
  if (!Array.isArray(tree)) {
    throw new BadRequest("GitHub answered with no folder listing");
  }
  if ((parsed as { truncated?: unknown }).truncated === true) {
    throw new BadRequest("the folder is too large to list");
  }
  if (tree.length > MAX_ARCHIVE_MEMBERS) {
    throw new BadRequest("the folder has too many entries");
  }
  const out: Blob[] = [];
  let bytes = 0;
  for (const value of tree) {
    const item = value as Record<string, unknown>;
    if (typeof item?.path !== "string" || !validPath(item.path)) {
      throw new BadRequest("GitHub answered with an invalid folder listing");
    }
    // a submodule is a commit and a symlink a blob with its own mode
    if (item.type !== "blob" || item.mode === SYMLINK) continue;
    if (typeof item.size !== "number" || !Number.isSafeInteger(item.size)) {
      throw new BadRequest("GitHub answered with an invalid folder listing");
    }
    out.push({ path: item.path, size: item.size });
    if (out.length > MAX_FILES + 1) {
      throw new BadRequest("the skill has too many files");
    }
    bytes += item.size;
    if (bytes > MAX_TAR_BYTES) throw new BadRequest("the folder is too large");
  }
  return out;
}

// GitHub's own words for a repo or ref it will not show
async function asked<T>(folder: GithubFolder, read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (
      error instanceof BadGateway &&
      / answered (404|422)$/.test(error.message)
    ) {
      throw new BadRequest(
        `GitHub has no ${folder.owner}/${folder.repo} at ${folder.ref}, or it is private`,
      );
    }
    throw error;
  }
}

// The folder alone is listed and read, never the repo's archive, so the
// caps count the skill and a repo of any size works. The ref is pinned
// to one commit first, so the listing and the files agree.
export async function fetchGithubFolder(
  fetcher: typeof fetch,
  folder: GithubFolder,
  shutdown: AbortSignal,
  // each read keeps its own deadline; this bounds the whole folder
  deadlineMs = 3 * FETCH_DEADLINE_MS,
): Promise<Picked> {
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = AbortSignal.any([shutdown, deadline]);
  try {
    const commit = (
      await asked(folder, () =>
        fetchText(fetcher, commitUrl(folder), signal, 64, SHA_ACCEPT),
      )
    ).text.trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new BadRequest("GitHub answered with no commit");
    }
    const listing = await asked(folder, () =>
      fetchText(
        fetcher,
        treeUrl(folder, commit),
        signal,
        MAX_INDEX_BYTES,
        JSON_ACCEPT,
      ),
    ).catch((error) => {
      if (
        error instanceof BadRequest &&
        error.message.startsWith("GitHub has no")
      ) {
        throw new BadRequest(
          `GitHub has no folder ${folder.path} at ${folder.ref}`,
        );
      }
      throw error;
    });
    const files = blobs(listing.text);
    if (!files.some((file) => file.path === "SKILL.md")) {
      throw new BadRequest("no SKILL.md at that path");
    }
    const read = new Map<string, Uint8Array>();
    for (let at = 0; at < files.length; at += PARALLEL) {
      const batch = files.slice(at, at + PARALLEL);
      const stop = new AbortController();
      const each = AbortSignal.any([signal, stop.signal]);
      const bodies = await Promise.all(
        batch.map((file) =>
          download(
            fetcher,
            rawUrl(folder, commit, `${folder.path}/${file.path}`),
            each,
            file.size,
          ).catch((error) => {
            stop.abort();
            throw error;
          }),
        ),
      );
      for (const [index, file] of batch.entries()) {
        read.set(file.path, bodies[index]!);
      }
    }
    const skillMd = read.get("SKILL.md")!;
    read.delete("SKILL.md");
    return { skillMd, files: read };
  } catch (error) {
    if (
      error instanceof ServiceUnavailable &&
      deadline.aborted &&
      !shutdown.aborted
    ) {
      throw new BadGateway("GitHub took too long to answer");
    }
    throw error;
  }
}
