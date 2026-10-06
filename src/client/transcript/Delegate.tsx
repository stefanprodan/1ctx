// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent's group in the work fold: shut until opened, like a call.
// While the chat is watched its rows arrive as frames; opened later
// with nothing held, it reads them from the child route once. The
// child's calls are drawn by the rows the fold draws the parent's with.

import { useEffect } from "preact/hooks";
import { childWork, loadChild } from "../data/session-children.ts";
import { Icon } from "../lib/icons.tsx";
import {
  childHead,
  childStatus,
  childView,
  description,
  taskOf,
} from "./Delegate.model.ts";
import { folds } from "./fold.ts";
import { Rounds } from "./Rounds.tsx";
import type { CallNode } from "./rows.ts";
import { Tool, Value } from "./Tool.tsx";

const { useFoldOpen } = folds();
const NO_LIVE = new Map();

export function Delegate({ node }: { node: CallNode }) {
  const row = node.result!;
  const { open, onToggle } = useFoldOpen(node.key);
  const entry = childWork.value.get(row.id);
  const work = entry?.work ?? null;
  const wanted =
    open && entry === undefined && row.childSessionId !== undefined;
  useEffect(() => {
    if (wanted) void loadChild(row.id);
  }, [wanted, row.id]);
  const status = childStatus(row, work);
  const view = childView(work?.rows ?? []);
  const task = taskOf(node);
  return (
    <details
      class={`transcript-fold${status === "running" ? " transcript-fold-live" : ""}${
        open ? " transcript-fold-open" : ""
      }`}
      data-call={node.call.id}
      open={open}
      onToggle={onToggle}
    >
      <summary class="transcript-fold-head transcript-fold-small">
        <Icon name="spinner" size={12} class="transcript-fold-spin" />
        <Icon name="chevron-right" size={12} class="transcript-fold-chevron" />
        <span class="transcript-child-title cut">{description(node)}</span>
        <span
          class={`transcript-tool-state${
            status === "failed" ? " transcript-tool-failed" : ""
          }`}
        >
          {childHead(status, work)}
        </span>
      </summary>
      <div class="transcript-work-rounds">
        {task !== "" && (
          <div class="transcript-child-task">
            <div class="transcript-tool-label">task</div>
            <Value text={task} />
          </div>
        )}
        <Rounds
          rounds={view.rounds}
          live={NO_LIVE}
          running={false}
          call={(call) => <Tool key={call.key} node={call} />}
        />
        {entry?.loading === true && work === null && (
          <div class="transcript-work-plain">loading</div>
        )}
        {entry?.error != null && (
          <div class="transcript-work-plain transcript-tool-failed">
            {entry.error}
          </div>
        )}
        {view.answer !== null && view.answer.html !== "" && (
          <div
            class="transcript-md transcript-child-answer"
            // the server renders a reply's markdown, as the answer's
            dangerouslySetInnerHTML={{ __html: view.answer.html }}
          />
        )}
      </div>
    </details>
  );
}
