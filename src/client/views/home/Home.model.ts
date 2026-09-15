// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the Home head says, and what the page reads from the address
// and the rail's list.

import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import type { SessionOrigin } from "../../../shared/words.ts";

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

// the composer starts a chat in the project the user picked while it
// is still listed, else in the personal project: the one of its kind a
// user sees, since another's is never listed
export function composeProjectOf(
  rows: ProjectSummary[] | null,
  picked: string | null,
): ProjectSummary | null {
  return (
    rows?.find((p) => p.id === picked) ??
    rows?.find((p) => p.kind === "personal") ??
    null
  );
}

// the search as the address carries it
export function searchOf(search: string): string {
  return new URLSearchParams(search).get("q")?.trim() ?? "";
}

// the stream's filter as the address carries it: chats, task runs, or
// null for both
export function originOf(search: string): SessionOrigin | null {
  const origin = new URLSearchParams(search).get("origin");
  return origin === "chat" || origin === "automation" ? origin : null;
}

// the address for a query and a filter on a page, none when both are
// blank
export function searchHref(
  pathname: string,
  q: string,
  origin: SessionOrigin | null = null,
): string {
  const params = new URLSearchParams();
  if (q.trim() !== "") params.set("q", q.trim());
  if (origin !== null) params.set("origin", origin);
  const search = params.toString();
  return `${pathname}${search === "" ? "" : `?${search}`}`;
}

// what the stream says with no rows
export function emptyLine(q: string, origin: SessionOrigin | null): string {
  if (q !== "") return "No sessions match";
  if (origin === "chat") return "No chats yet";
  if (origin === "automation") return "No task runs yet";
  return "No sessions found";
}
