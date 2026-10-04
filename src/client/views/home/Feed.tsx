// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What Home and a project's Feed tab share: the composer's send, which
// starts a chat in the project, and the feed under it, searched and
// filtered through the address at `path`, a page at a time.

import { navigate, query } from "../../app/router.ts";
import { createSession, list, loadMore } from "../../data/sessions.ts";
import { FeedCard } from "../../feed/FeedCard.tsx";
import { tickMs } from "../../feed/Row.model.ts";
import { useNow } from "../../lib/now.ts";
import { emptyLine, pickOf, searchHref, searchOf } from "./Home.model.ts";

export const startChat =
  (projectId: string) =>
  async (message: string, agentId: string, uploads: string[]) => {
    await createSession({
      projectId,
      agentId,
      message,
      ...(uploads.length === 0 ? {} : { uploads }),
    });
  };

export function Feed({
  path,
  projectName,
}: {
  path: string;
  projectName: (projectId: string) => string | null;
}) {
  const held = list.value;
  const rows = held?.rows ?? null;
  const now = useNow(tickMs(rows));
  const q = searchOf(query.value);
  const pick = pickOf(query.value);
  return (
    <FeedCard
      rows={rows}
      projectName={projectName}
      search={{
        value: q,
        onChange: (next) => navigate(searchHref(path, next, pick), true),
      }}
      filter={{
        value: pick,
        onPick: (next) => navigate(searchHref(path, q, next), true),
      }}
      empty={emptyLine(q, pick)}
      now={now}
      more={{
        next: (held?.next ?? null) !== null,
        loading: held?.more.loading ?? false,
        error: held?.more.error ?? null,
      }}
      onMore={() => void loadMore()}
    />
  );
}
