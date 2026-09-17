// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A tool's row, built like every admin row: the name over the first
// sentence of its description, for a built-in the tokens its schema
// costs as the row's meta, and for a web tool its switch. It opens in place to when a send
// carries it, the text and the parameters the model gets, read-only.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type {
  BuiltinToolSummary,
  WebToolSummary,
} from "../../../shared/contracts/tool.ts";
import { patchTool } from "../../data/tools.ts";
import { reason } from "../../lib/format.ts";
import { copyCode } from "../../transcript/copy.ts";
import {
  RowsEnd,
  RowsMeta,
  RowsOpen,
  RowsSwitch,
  RowsTitle,
} from "../../ui/Rows.tsx";
import {
  firstSentence,
  NAMES_WORDS,
  tokensText,
  WHEN_WORDS,
} from "./Tools.model.ts";
import "../../transcript/hljs.css";
import "../../transcript/md.css";
import "./tools.css";

function Switch({ tool }: { tool: WebToolSummary }) {
  const busy = useSignal(false);
  const failure = useSignal<string | null>(null);
  const flip = async () => {
    busy.value = true;
    failure.value = null;
    try {
      await patchTool(tool.name, { enabled: !tool.enabled });
    } catch (err) {
      failure.value = reason(err);
    }
    busy.value = false;
  };
  return (
    <RowsEnd error={failure.value}>
      <RowsSwitch
        on={tool.enabled}
        label={tool.name}
        disabled={busy.value}
        onClick={() => void flip()}
      />
    </RowsEnd>
  );
}

export function ToolRow({
  tool,
  open,
  onToggle,
}: {
  tool: BuiltinToolSummary | WebToolSummary;
  open: boolean;
  onToggle: () => void;
}) {
  // the block's Copy is a button inside rendered HTML, so the click is
  // delegated the way the transcript does it
  const json = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = json.current;
    if (!el) return;
    const on = (ev: MouseEvent) => void copyCode(ev);
    el.addEventListener("click", on);
    return () => el.removeEventListener("click", on);
  }, [open]);
  const builtin = "when" in tool ? tool : null;
  return (
    <RowsOpen
      open={open}
      onToggle={onToggle}
      indent="chevron"
      head={
        <>
          <RowsTitle
            name={tool.name}
            sub={firstSentence(tool.description)}
            mono
          />
          {builtin && <RowsMeta>{tokensText(tool.tokens)}</RowsMeta>}
        </>
      }
      end={"enabled" in tool ? <Switch tool={tool} /> : undefined}
    >
      <div class="tools-schema">
        {builtin && (
          <>
            <div class="tools-label">When</div>
            <div class="tools-text">{WHEN_WORDS[builtin.when]}</div>
          </>
        )}
        <div class="tools-label">Description for agents</div>
        <div class="tools-text">{tool.description}</div>
        {builtin?.variant && (
          <>
            <div class="tools-label">
              Description for an automation's own memory,{" "}
              {tokensText(builtin.variant.tokens)}
            </div>
            <div class="tools-text">{builtin.variant.description}</div>
          </>
        )}
        <div class="tools-label">Parameters</div>
        {builtin?.names && <div class="hint">{NAMES_WORDS}</div>}
        {/* Server rendering keeps the Markdown parser out of the browser. */}
        <div
          class="tools-json"
          ref={json}
          dangerouslySetInnerHTML={{ __html: tool.parametersHtml }}
        />
      </div>
    </RowsOpen>
  );
}
