// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Method, RouteOutcome } from "../lib/http.ts";

export type Handle = (
  request: Request,
  address: string,
) => Promise<RouteOutcome>;

export type Client = ReturnType<typeof client>;

export function client(handle: Handle) {
  let cookie = "";
  return {
    async call<T>(method: Method, path: string, body?: unknown): Promise<T> {
      const headers = new Headers();
      if (cookie) headers.set("cookie", cookie);
      if (body !== undefined) headers.set("content-type", "application/json");
      const response = await handle(
        new Request(`http://localhost${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        "127.0.0.1",
      );
      if (!response) throw new Error("the request did not return a response");
      const setCookie = response.headers.get("set-cookie");
      if (setCookie !== null) cookie = setCookie.split(";")[0];
      if (!response.ok) {
        const body: unknown = await response.json();
        const words =
          body !== null &&
          typeof body === "object" &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : `request failed (HTTP ${response.status})`;
        throw new Error(words);
      }
      return response.json();
    },
  };
}

export function difference<T extends object>(before: object, desired: T) {
  const patch: Partial<T> = {};
  const held = new Map(Object.entries(before));
  for (const key of Object.keys(desired) as (keyof T)[]) {
    if (!equal(held.get(String(key)), desired[key])) patch[key] = desired[key];
  }
  return patch;
}

function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    // Membership order is not stored; a reordered list is not a write.
    return (
      JSON.stringify(a.map(stable).sort()) ===
      JSON.stringify(b.map(stable).sort())
    );
  }
  return stable(a) === stable(b);
}

function stable(value: unknown): string | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
  }
  return JSON.stringify(value);
}
