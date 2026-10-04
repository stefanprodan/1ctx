// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the Home head says, and what the page reads from the address
// and the rail's list.

import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import type { SessionOrigin } from "../../../shared/words.ts";
import type { FeedPick } from "../../feed/FeedCard.tsx";

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

// the pick as the address carries it: attention=1, else the origin
export function pickOf(search: string): FeedPick | null {
  const params = new URLSearchParams(search);
  if (params.get("attention") === "1") return "attention";
  const origin = params.get("origin");
  return origin === "chat" || origin === "automation" ? origin : null;
}

// what the feed's list reads for a pick
export function listPick(pick: FeedPick | null): {
  origin: SessionOrigin | null;
  attention: boolean;
} {
  return pick === "attention"
    ? { origin: null, attention: true }
    : { origin: pick, attention: false };
}

// the address for a query and a pick on a page, none when both are
// blank
export function searchHref(
  pathname: string,
  q: string,
  pick: FeedPick | null = null,
): string {
  const params = new URLSearchParams();
  if (q.trim() !== "") params.set("q", q.trim());
  if (pick === "attention") params.set("attention", "1");
  else if (pick !== null) params.set("origin", pick);
  const search = params.toString();
  return `${pathname}${search === "" ? "" : `?${search}`}`;
}

// what the feed says with no rows
export function emptyLine(q: string, origin: FeedPick | null): string {
  if (q !== "") return "No sessions match";
  if (origin === "attention") return "Nothing flagged";
  if (origin === "chat") return "No chats yet";
  if (origin === "automation") return "No task runs yet";
  return "No sessions found";
}
