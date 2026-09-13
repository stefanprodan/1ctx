// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the Home head says, and what the page reads from the address
// and the rail's list.

import type { ProjectSummary } from "../../../shared/contracts/project.ts";

export function dateLine(now: Date): string {
  return now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export function greeting(now: Date, name: string): string {
  const hour = now.getHours();
  const word =
    hour < 5
      ? "Good night"
      : hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening";
  return `${word}, ${name}`;
}

// the composer starts a chat in the personal project: the one of its
// kind a user sees, since another's is never listed
export function personalOf(
  rows: ProjectSummary[] | null,
): ProjectSummary | null {
  return rows?.find((p) => p.kind === "personal") ?? null;
}

// the search as the address carries it
export function searchOf(search: string): string {
  return new URLSearchParams(search).get("q")?.trim() ?? "";
}

// the address for a query on a page, none when it is blank
export function searchHref(pathname: string, q: string): string {
  const params = new URLSearchParams();
  if (q.trim() !== "") params.set("q", q.trim());
  const search = params.toString();
  return `${pathname}${search === "" ? "" : `?${search}`}`;
}
