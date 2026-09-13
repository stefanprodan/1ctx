// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";
import { Icon } from "../lib/icons.tsx";
import type { CallNode } from "./rows.ts";
import { displayResult, prettyArguments, toolSummary } from "./Tool.model.ts";

const opened = signal<ReadonlySet<string>>(new Set());

export function Tool({ node }: { node: CallNode }) {
  const open = opened.value.has(node.key);
  const summary = toolSummary(node.call, node.result);
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
        <div class="transcript-tool-label">result, untrusted</div>
        <div class="transcript-tool-value">{displayResult(node.result)}</div>
      </div>
    </details>
  );
}
