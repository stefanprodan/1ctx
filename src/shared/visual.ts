// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The hosts a visual may load scripts, styles and fonts from, as an
// admin lists them: HTTPS origins on the default port, stored as the
// URL parser writes them. The server checks each stored entry as sent;
// the admin's box is lines, trimmed, so a refusal names its line.

export const MAX_VISUAL_HOSTS = 16;

// one entry to its origin, null when it is not a plain HTTPS origin.
// The spelling is checked before URL can erase a path, escape or
// separator.
export function visualOrigin(host: string): string | null {
  if (!/^https:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::443)?\/?$/i.test(host)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return null;
  }
  if (
    !url.hostname.startsWith("[") &&
    !url.hostname
      .replace(/\.$/, "")
      .split(".")
      .every(
        (label) =>
          label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
      )
  ) {
    return null;
  }
  return url.origin;
}

export type VisualHostsResult =
  | { ok: true; hosts: string[] }
  // the first line that is not an origin, 1-based, as the person typed it
  | { ok: false; line: number; value: string; error: string };

// the lines of the hosts box: blank lines dropped, each an origin,
// sorted and deduped
export function parseVisualHosts(lines: readonly string[]): VisualHostsResult {
  const hosts = new Set<string>();
  for (const [index, raw] of lines.entries()) {
    const value = raw.trim();
    if (value === "") continue;
    const origin = visualOrigin(value);
    if (origin === null) {
      return {
        ok: false,
        line: index + 1,
        value: value.slice(0, 80),
        error: "is not an HTTPS origin",
      };
    }
    hosts.add(origin);
  }
  if (hosts.size > MAX_VISUAL_HOSTS) {
    return {
      ok: false,
      line: lines.length,
      value: "",
      error: `at most ${MAX_VISUAL_HOSTS} hosts`,
    };
  }
  return { ok: true, hosts: [...hosts].sort() };
}
