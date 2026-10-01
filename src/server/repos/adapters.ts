// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The git hosts a repository may live on, pure: a URL's normalized form
// and the URLs each host answers for it. Every path segment is held to
// a plain charset, so no URL built here carries an escape it did not
// make itself and a credential's prefix is compared as text.

import {
  MAX_REPO_REF,
  MAX_REPO_URL,
  PUBLIC_REPO_HOSTS,
  type RepoKind,
} from "../../shared/contracts/repo.ts";
import { isName } from "../../shared/words.ts";

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const refused = (error: string) => ({ ok: false, error }) as const;

// never a lone or leading dash, which GitLab keeps for its own pages
const SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/;
const MAX_SEGMENTS = 20;

export type RepoUrl = {
  // https://host/path, the host lowercased, no .git, no trailing slash
  url: string;
  host: string;
  // the segments after the host: owner and repo, or a GitLab path
  segments: string[];
  // the kind a public host fixes, null for any other host
  kind: RepoKind | null;
};

// https alone, no userinfo, query or fragment; .git and a trailing
// slash dropped
export function normalizeUrl(value: unknown): Checked<RepoUrl> {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > MAX_REPO_URL
  ) {
    return refused(`url must be a URL of at most ${MAX_REPO_URL} characters`);
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return refused("url must be a URL");
  }
  if (url.protocol !== "https:") return refused("url must be https");
  if (url.username !== "" || url.password !== "") {
    return refused("url must not hold a user or a password");
  }
  if (url.search !== "" || url.hash !== "" || /[?#]/.test(value)) {
    return refused("url must not hold a query or a fragment");
  }
  const host = url.host.replace(/\.$/, "").replace(/\.:/, ":");
  if (url.hostname === "" || url.hostname.replace(/\.$/, "").endsWith(".")) {
    return refused("url must name a host");
  }
  const segments = url.pathname.split("/").filter((part) => part !== "");
  const last = segments.length - 1;
  if (last >= 0) segments[last] = segments[last]!.replace(/\.git$/, "");
  if (
    segments.some(
      (part) => !SEGMENT.test(part) || part === "." || part === "..",
    )
  ) {
    return refused(
      "url path must be segments of letters, digits, dots, dashes and underscores",
    );
  }
  if (segments.length < 2 || segments.length > MAX_SEGMENTS) {
    return refused("url must name a repository: https://host/owner/name");
  }
  const kind =
    (PUBLIC_REPO_HOSTS as Record<string, RepoKind | undefined>)[host] ?? null;
  if (kind === "github" && segments.length !== 2) {
    return refused("url must be https://github.com/owner/name");
  }
  return {
    ok: true,
    value: {
      url: `https://${host}/${segments.join("/")}`,
      host,
      segments,
      kind,
    },
  };
}

// the URL's last segment as a name, when isName takes it
export function defaultName(repo: Pick<RepoUrl, "segments">): string | null {
  const name = repo.segments
    .at(-1)!
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
  return isName(name) ? name : null;
}

// a branch, a tag or a commit; letters, digits and . _ / + - only, so a
// ref goes into a path as it is and into a query encoded
export function checkRef(value: unknown): Checked<string> {
  if (typeof value !== "string" || value.length > MAX_REPO_REF) {
    return refused(`ref must be at most ${MAX_REPO_REF} characters`);
  }
  if (value === "") return { ok: true, value };
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/+-]*$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.split("/").some((part) => part.startsWith("."))
  ) {
    return refused(
      "ref must be a branch, a tag or a commit of letters, digits and . _ / + -",
    );
  }
  return { ok: true, value };
}

// a full commit id needs no lookup
export const isCommit = (ref: string): boolean =>
  /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(ref);

export type Adapter = {
  kind: RepoKind;
  host: string;
  // the API's base for this repository, ending in /, which a credential's
  // prefix must cover
  apiBase: string;
  // the commit a ref (or the default branch) points at
  lookupUrl(ref: string): string;
  lookupHeaders: Record<string, string>;
  // the tarball at a commit, through the API
  tarballUrl(commit: string): string;
  // the tarball at a ref, unsigned, the public way
  archiveUrl(ref: string): string;
  // the repository's page, for a person
  page: string;
};

const refOrHead = (ref: string) => (ref === "" ? "HEAD" : ref);

function github(repo: RepoUrl): Adapter {
  const [owner, name] = repo.segments as [string, string];
  const dotCom = repo.host === "github.com";
  const apiBase = dotCom
    ? `https://api.github.com/repos/${owner}/${name}/`
    : `https://${repo.host}/api/v3/repos/${owner}/${name}/`;
  return {
    kind: "github",
    host: repo.host,
    apiBase,
    lookupUrl: (ref) => `${apiBase}commits/${refOrHead(ref)}`,
    lookupHeaders: { accept: "application/vnd.github.sha" },
    tarballUrl: (commit) => `${apiBase}tarball/${commit}`,
    archiveUrl: (ref) =>
      dotCom
        ? `https://codeload.github.com/${owner}/${name}/tar.gz/${refOrHead(ref)}`
        : `${repo.url}/archive/${refOrHead(ref)}.tar.gz`,
    page: repo.url,
  };
}

function gitlab(repo: RepoUrl): Adapter {
  const path = repo.segments.join("/");
  const name = repo.segments.at(-1)!;
  const apiBase = `https://${repo.host}/api/v4/projects/${encodeURIComponent(path)}/`;
  return {
    kind: "gitlab",
    host: repo.host,
    apiBase,
    lookupUrl: (ref) =>
      `${apiBase}repository/commits/${encodeURIComponent(refOrHead(ref))}`,
    lookupHeaders: {},
    tarballUrl: (commit) => `${apiBase}repository/archive.tar.gz?sha=${commit}`,
    // GitLab names the file with the ref's slashes as dashes
    archiveUrl: (ref) => {
      const at = refOrHead(ref);
      return `${repo.url}/-/archive/${at}/${name}-${at.replaceAll("/", "-")}.tar.gz`;
    },
    page: repo.url,
  };
}

// a URL held in a row, normalized when it was saved
export function adapter(url: string, kind: RepoKind): Adapter {
  const parsed = normalizeUrl(url);
  if (!parsed.ok) throw new Error("a stored repository URL does not parse");
  return (parsed.value.kind ?? kind) === "github"
    ? github(parsed.value)
    : gitlab(parsed.value);
}

// a credential's prefix, held by normalizePrefix(), covers a URL built
// here: one origin, and the path under the prefix on a segment boundary
export function covers(prefix: string, url: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(prefix);
    b = new URL(url);
  } catch {
    return false;
  }
  if (a.origin !== b.origin) return false;
  const path = a.pathname;
  if (path === "/" || path === "") return true;
  return path.endsWith("/")
    ? b.pathname.startsWith(path)
    : b.pathname === path || b.pathname.startsWith(`${path}/`);
}
