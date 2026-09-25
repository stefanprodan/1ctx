// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The head notices the file pages share: a refusal in the server's
// words with its status, the delete that asks, and another writer's
// word.

import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { KnowledgeAuthor } from "../../../../shared/contracts/knowledge.ts";
import { ago } from "../../../lib/format.ts";
import { noticeOf, type Problem } from "../../../lib/save.ts";
import { PageNotice } from "../../../ui/Page.tsx";
import { Author } from "../Author.tsx";
import { authorOf } from "../Knowledge.model.ts";

export function ProblemNotice({
  problem,
  children,
}: {
  problem: Problem;
  children?: ComponentChildren;
}) {
  return (
    <PageNotice
      tone="failed"
      words={
        <>
          {noticeOf(problem)}
          {problem.status !== undefined && (
            <>
              {" "}
              <span class="code-tag">HTTP {problem.status}</span>
            </>
          )}
        </>
      }
    >
      {children}
    </PageNotice>
  );
}

// how long a deleted file's text is kept, left out while the limits
// are not known
export function keptFor(days: number | null): string {
  return days === null ? "" : ` Its text is kept up to ${days} days.`;
}

// the ask takes the focus to Keep, the answer that loses nothing
export function DeleteAsk({
  days,
  busy,
  deleting,
  onKeep,
  onDelete,
}: {
  days: number | null;
  busy: boolean;
  deleting: boolean;
  onKeep: () => void;
  onDelete: () => void;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => keep.current?.focus(), []);
  return (
    <PageNotice
      tone="failed"
      words={`Delete this file? Agents stop seeing it.${keptFor(days)}`}
    >
      <button
        ref={keep}
        type="button"
        class="btn btn-small"
        disabled={busy}
        onClick={onKeep}
      >
        Keep
      </button>
      <button
        type="button"
        class="btn btn-small btn-danger"
        disabled={busy}
        onClick={onDelete}
      >
        {deleting ? "Deleting" : "Delete"}
      </button>
    </PageNotice>
  );
}

// another writer's word: "sre in a chat changed this file 1m ago." and
// what the page says after it
export function WroteNotice({
  author,
  at,
  now,
  verb,
  after = "",
  failed,
  children,
}: {
  author: KnowledgeAuthor;
  at: number;
  now: number;
  verb: "changed" | "deleted";
  after?: string;
  failed?: boolean;
  children?: ComponentChildren;
}) {
  return (
    <PageNotice
      tone={failed ? "failed" : "info"}
      words={
        <>
          <Author words={authorOf(author)} /> {verb} this file {ago(at, now)}.
          {after}
        </>
      }
    >
      {children}
    </PageNotice>
  );
}
