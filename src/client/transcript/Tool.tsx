// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal, useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { loadToolResult, toolResults } from "../data/sessions.ts";
import { Icon } from "../lib/icons.tsx";
import { onResize } from "../lib/resize.ts";
import { Fold } from "../ui/Fold.tsx";
import type { CallNode } from "./rows.ts";
import {
  displayResult,
  prettyArguments,
  ranCall,
  toolLabel,
  toolSummary,
  wantsResult,
} from "./Tool.model.ts";

const opened = signal<ReadonlySet<string>>(new Set());

// a value is cut to a few lines, Show all in its fade, never a scroll box
// of its own; once open it stays whole until the fold closes
function Value({ text, failed }: { text: string; failed?: boolean }) {
  const open = useSignal(false);
  const long = useSignal(false);
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = el.current;
    if (node === null) return;
    const measure = () => {
      if (!open.value) long.value = node.scrollHeight > node.clientHeight + 1;
    };
    measure();
    return onResize(node, measure);
  }, [text, open, long]);
  return (
    <Fold
      cut={long.value && !open.value}
      onOpen={() => {
        open.value = true;
      }}
      label="Show all"
    >
      <div
        ref={el}
        class={`transcript-tool-value${
          open.value ? " transcript-tool-value-all" : ""
        }${failed ? " transcript-tool-failed" : ""}`}
      >
        {text}
      </div>
    </Fold>
  );
}

export function Tool({ node }: { node: CallNode }) {
  const open = opened.value.has(node.key);
  const summary = toolSummary(node.call, node.result);
  const label = toolLabel(ranCall(node.call, node.result).name);
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
      class={`transcript-fold${summary.live ? " transcript-fold-live" : ""}${
        open ? " transcript-fold-open" : ""
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
      <summary class="transcript-fold-head transcript-fold-small">
        <Icon name="spinner" size={12} class="transcript-fold-spin" />
        <Icon name="chevron-right" size={12} class="transcript-fold-chevron" />
        {label.server !== null && (
          <span class="transcript-tool-server">{label.server}</span>
        )}
        <span class="transcript-tool-name">{label.tool}</span>
        {summary.argument !== "" && (
          <span class="transcript-tool-argument cut">{summary.argument}</span>
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
        <Value text={prettyArguments(node.call.arguments)} />
        <div class="transcript-tool-label">{shown.label}</div>
        <Value text={shown.text} failed={shown.err} />
      </div>
    </details>
  );
}
