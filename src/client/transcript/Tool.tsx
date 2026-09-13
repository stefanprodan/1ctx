// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { loadToolResult, toolResults } from "../data/sessions.ts";
import { Icon } from "../lib/icons.tsx";
import type { CallNode } from "./rows.ts";
import {
  displayResult,
  prettyArguments,
  toolSummary,
  wantsResult,
} from "./Tool.model.ts";

const opened = signal<ReadonlySet<string>>(new Set());

export function Tool({ node }: { node: CallNode }) {
  const open = opened.value.has(node.key);
  const summary = toolSummary(node.call, node.result);
  const held =
    node.result === null ? undefined : toolResults.value.get(node.result.id);
  const resultId = node.result?.id ?? null;
  // the result is off the wire: asked for when the row is open and the
  // tool has ended, so a row opened while it runs asks once it is done
  const wanted = resultId !== null && wantsResult(open, node.result, held);
  useEffect(() => {
    if (wanted && resultId !== null) void loadToolResult(resultId);
  }, [wanted, resultId]);
  const shown = displayResult(node.result, held);
  return (
    <details
      class={`transcript-tool${summary.live ? " transcript-tool-live" : ""}${
        open ? " transcript-tool-open" : ""
      }`}
      data-call={node.call.id}
      open={open}
      onToggle={(event) => {
        const next = new Set(opened.value);
        if (event.currentTarget.open) next.add(node.key);
        else next.delete(node.key);
        opened.value = next;
      }}
    >
      <summary class="transcript-tool-head">
        <Icon name="spinner" size={12} class="transcript-tool-spin" />
        <Icon name="chevron-right" size={12} class="transcript-tool-chevron" />
        <span class="transcript-tool-name">{node.call.name}</span>
        {summary.argument !== "" && (
          <span class="transcript-tool-argument">{summary.argument}</span>
        )}
        <span
          class={`transcript-tool-state${
            node.result?.status === "failed" ? " transcript-tool-failed" : ""
          }`}
        >
          {summary.state}
        </span>
      </summary>
      <div class="transcript-tool-detail">
        <div class="transcript-tool-label">arguments</div>
        <div class="transcript-tool-value">
          {prettyArguments(node.call.arguments)}
        </div>
        <div class="transcript-tool-label">{shown.label}</div>
        <div
          class={`transcript-tool-value${
            shown.err ? " transcript-tool-failed" : ""
          }`}
        >
          {shown.text}
        </div>
      </div>
    </details>
  );
}
