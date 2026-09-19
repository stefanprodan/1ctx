// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Every request the binary makes names it, never the runtime: a provider,
// an MCP server and a skill's host see `1ctx/<version>`. A caller that set
// its own header keeps it.

export function userAgent(version: string): string {
  return `1ctx/${version}`;
}

export function withUserAgent(
  base: typeof fetch,
  version: string,
): typeof fetch {
  const named = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const given =
      init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers = new Headers(given);
    if (headers.has("user-agent")) return base(input, init);
    // a plain record stays one, since that is what a caller's fake reads
    if (
      given !== undefined &&
      !(given instanceof Headers) &&
      !Array.isArray(given)
    ) {
      return base(input, {
        ...init,
        headers: { ...given, "user-agent": userAgent(version) },
      });
    }
    headers.set("user-agent", userAgent(version));
    return base(input, { ...init, headers });
  };
  return Object.assign(named, { preconnect: base.preconnect });
}
