// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandbox shell's own network: the hosts its commands may reach, as
// OpenShell's policy takes them. OpenShell cannot open every name (a
// wildcard needs three labels, and a rule without a host reaches raw
// addresses alone), so the sandbox lists its hosts and never follows Web
// access. One parser for the admin page and the route.

import type { SandboxNetwork } from "./contracts/sandbox.ts";
import { hostOf, MAX_WEB_DOMAIN } from "./web.ts";

export const MAX_SANDBOX_HOSTS = 200;

// Package registries, code hosts, CDNs and reference docs an agent
// installs from or reads, sorted as a save stores them
export const SANDBOX_DEFAULT_HOSTS: readonly string[] = [
  // package registries and the hosts their installers download from
  "pypi.org",
  "files.pythonhosted.org",
  "registry.npmjs.org",
  "proxy.golang.org",
  "sum.golang.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "rubygems.org",
  "repo1.maven.org",
  "repo.maven.apache.org",
  "conda.anaconda.org",
  "repo.anaconda.com",
  "cloud.r-project.org",
  "cran.r-project.org",
  // runtimes and their installers; go.dev/dl hands Go's tarballs to
  // dl.google.com
  "nodejs.org",
  "go.dev",
  "dl.google.com",
  "astral.sh",
  "bun.sh",
  // code hosts, raw files and release downloads included
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "*.githubusercontent.com",
  "gitlab.com",
  "huggingface.co",
  // Hugging Face's file downloads redirect to its CDNs under hf.co
  "**.hf.co",
  // CDNs a page or visual pulls front-end libraries from
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "esm.sh",
  // reference docs
  "docs.python.org",
  "developer.mozilla.org",
  "pkg.go.dev",
  "docs.rs",
  "www.npmjs.com",
  "*.readthedocs.io",
  "*.wikipedia.org",
  "stackoverflow.com",
  // public data
  "query.wikidata.org",
].sort();

// the network a command runs under, the defaults put in for null
export type SandboxNet = { mode: SandboxNetwork; hosts: readonly string[] };

export const sandboxNet = (settings: {
  network: SandboxNetwork;
  hosts: readonly string[] | null;
}): SandboxNet => ({
  mode: settings.network,
  hosts: settings.hosts ?? SANDBOX_DEFAULT_HOSTS,
});

export type HostsResult =
  | { ok: true; hosts: string[] }
  // the first line that is not a host, 1-based, as the person typed it
  | { ok: false; line: number; value: string; error: string };

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// `**` whole, a plain label, or one `*` within letters, digits and
// inner hyphens: with a letter in its place it is a plain label, so
// `*-api` passes and `-*` or `*-` never reach OpenShell's load
const firstOk = (label: string) =>
  label === "**" ||
  LABEL.test(label) ||
  (label.split("*").length === 2 && LABEL.test(label.replace("*", "x")));
// stands in for a whole `*` label while the rest is turned to ASCII; a
// typed label that comes out as it is refused, never read as a `*`
const STAND_IN = "x--wildcard";

// OpenShell's wildcard: three labels at least, `*` within the first
// label or as a whole later one, `**` only as the whole first label.
// The labels after the first go through the URL parser as a plain host
// does, so an IDN becomes its ASCII form
function wildcardOf(line: string): string | null {
  const trimmed = line.endsWith(".") ? line.slice(0, -1) : line;
  if (trimmed.length > MAX_WEB_DOMAIN || /[\s/:?#@\\[\]]/.test(trimmed))
    return null;
  const labels = trimmed.toLowerCase().split(".");
  if (labels.length < 3) return null;
  const [first, ...rest] = labels;
  if (!firstOk(first!)) return null;
  if (rest.some((label) => label !== "*" && label.includes("*"))) return null;
  const plain = hostOf(
    rest.map((label) => (label === "*" ? STAND_IN : label)).join("."),
  );
  if (plain === null) return null;
  const ascii = plain.split(".");
  if (
    ascii.length !== rest.length ||
    !ascii.every(
      (label, i) =>
        LABEL.test(label) && (label === STAND_IN) === (rest[i] === "*"),
    )
  )
    return null;
  const host = [
    first,
    ...ascii.map((label, i) => (rest[i] === "*" ? "*" : label)),
  ].join(".");
  return host.length > MAX_WEB_DOMAIN ? null : host;
}

function sandboxHostOf(line: string): { host: string } | { error: string } {
  if (line.includes("*")) {
    const host = wildcardOf(line);
    if (host !== null) return { host };
    return line.split(".").filter((label) => label !== "").length < 3
      ? { error: "needs three labels as a wildcard" }
      : { error: "is not a wildcard the sandbox takes" };
  }
  const host = hostOf(line);
  // an IPv6 literal is no host OpenShell matches
  if (host === null || host.startsWith("[")) {
    return { error: "is not a host name" };
  }
  return { host };
}

// the lines of the hosts box, or a stored list: blank lines dropped,
// each a host or a wildcard, sorted and deduped
export function parseSandboxHosts(lines: readonly string[]): HostsResult {
  const hosts = new Set<string>();
  for (const [index, raw] of lines.entries()) {
    const value = raw.trim();
    if (value === "") continue;
    const got = sandboxHostOf(value);
    if ("error" in got) {
      return {
        ok: false,
        line: index + 1,
        value: value.slice(0, 80),
        error: got.error,
      };
    }
    hosts.add(got.host);
  }
  if (hosts.size > MAX_SANDBOX_HOSTS) {
    return {
      ok: false,
      line: lines.length,
      value: "",
      error: `at most ${MAX_SANDBOX_HOSTS} hosts`,
    };
  }
  return { ok: true, hosts: [...hosts].sort() };
}

// the stored form of a list: null when it is the defaults, in any
// order, so a later release's defaults reach the instance
export function foldDefaults(hosts: readonly string[]): string[] | null {
  const sorted = [...new Set(hosts)].sort();
  return sorted.join("\n") === SANDBOX_DEFAULT_HOSTS.join("\n")
    ? null
    : [...hosts];
}

// the words naming the first ten hosts, then how many more
export function hostWords(hosts: readonly string[]): string {
  const first = hosts.slice(0, 10).join(", ");
  return hosts.length > 10 ? `${first} and ${hosts.length - 10} more` : first;
}
