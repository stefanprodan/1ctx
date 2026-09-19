// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Web access as an admin sets it: off, every domain, or only the hosts
// listed. A host is a plain name, matched whole: no wildcard, scheme,
// port or path, so a subdomain is a line of its own. The list is what
// the bash sandbox's allow-list is built from, and `originAllowed` is
// written to answer as that allow-list does, so webfetch and curl never
// disagree about a URL.

export const WEB_ACCESS_MODES = ["off", "all", "listed"] as const;
export type WebAccessMode = (typeof WEB_ACCESS_MODES)[number];
export function isWebAccessMode(value: unknown): value is WebAccessMode {
  return WEB_ACCESS_MODES.includes(value as WebAccessMode);
}

export const MAX_WEB_DOMAINS = 200;
// a DNS name's ceiling
export const MAX_WEB_DOMAIN = 253;

// the admin's setting as the wire carries it
export type WebAccess = {
  mode: WebAccessMode;
  // kept while the mode is off or all, read only while it is listed
  domains: string[];
  updatedAt: number;
};

// what a send runs under, null when it has no web access
export type WebSnapshot = { mode: "all" | "listed"; domains: string[] };

export type DomainsResult =
  | { ok: true; domains: string[] }
  // the first line that is not a host, 1-based, as the person typed it
  | { ok: false; line: number; value: string; error: string };

const LABEL = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
const NAME = new RegExp(`^${LABEL}(\\.${LABEL})*$`);

// one line to the host it names, null when it is not a plain host
function hostOf(line: string): string | null {
  if (line.length > MAX_WEB_DOMAIN || /[\s/*?#@\\]/.test(line)) return null;
  let url: URL;
  try {
    url = new URL(`http://${line}`);
  } catch {
    return null;
  }
  if (url.port !== "" || url.pathname !== "/") return null;
  // the URL parser lowercases, and turns an IDN into its ASCII form
  const host = url.hostname.endsWith(".")
    ? url.hostname.slice(0, -1)
    : url.hostname;
  if (host === "" || host.length > MAX_WEB_DOMAIN) return null;
  const literal = host.startsWith("[") && host.endsWith("]");
  // a port typed after the name was dropped by the parser when it is 80
  if (literal ? !line.endsWith("]") : line.includes(":")) return null;
  return literal || NAME.test(host) ? host : null;
}

// the lines of the domains box, or a stored list: blank lines dropped,
// each a plain host, sorted and deduped
export function parseDomains(lines: readonly string[]): DomainsResult {
  const hosts = new Set<string>();
  for (const [index, raw] of lines.entries()) {
    const value = raw.trim();
    if (value === "") continue;
    const host = hostOf(value);
    if (host === null) {
      return {
        ok: false,
        line: index + 1,
        value: value.slice(0, 80),
        error: "is not a host name",
      };
    }
    hosts.add(host);
  }
  if (hosts.size > MAX_WEB_DOMAINS) {
    return {
      ok: false,
      line: lines.length,
      value: "",
      error: `at most ${MAX_WEB_DOMAINS} hosts`,
    };
  }
  return { ok: true, domains: [...hosts].sort() };
}

// a listed host allows its http and https origins on their default
// ports, and nothing else: a custom port and a trailing dot are other
// origins to the sandbox's allow-list, so they are here too
export function originAllowed(url: URL, domains: readonly string[]): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.port !== "") return false;
  return domains.includes(url.hostname);
}

// the allow-list entries of the hosts, both schemes each
export function urlPrefixes(domains: readonly string[]): string[] {
  return domains.flatMap((host) => [`https://${host}`, `http://${host}`]);
}
