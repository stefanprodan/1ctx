// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "preact/hooks";
import type {
  BuiltinToolSummary,
  WebToolSummary,
} from "../../../shared/contracts/tool.ts";
import { firstSentence, showAll, tokensText } from "../../lib/format.ts";
import { useCut } from "../../lib/resize.ts";
import { copyCode } from "../../transcript/copy.ts";
import { Fold } from "../../ui/Fold.tsx";
import { RowsMeta, RowsOpen, RowsTitle } from "../../ui/Rows.tsx";
import {
  jsonLines,
  NAMES_WORDS,
  VARIANT_WHEN_WORDS,
  WHEN_WORDS,
} from "./Tools.model.ts";
import "../../transcript/hljs.css";
import "../../transcript/md.css";
import "./tools.css";

// Server rendering keeps the Markdown parser out of the browser. Mounted
// only while its row is open, so a fold forgets Show all.
export function ToolParams({ html, lines }: { html: string; lines: number }) {
  // cut, not a box that scrolls, which would leave the page's sticky
  // head behind
  const { el, open, long } = useCut<HTMLDivElement>([html]);
  // Copy is a button inside the rendered HTML, so the click is delegated
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const on = (ev: MouseEvent) => void copyCode(ev);
    node.addEventListener("click", on);
    return () => node.removeEventListener("click", on);
  }, []);
  return (
    <Fold
      cut={long.value && !open.value}
      onOpen={() => {
        open.value = true;
      }}
      label={showAll(lines)}
      framed
    >
      <div
        class={open.value ? undefined : "tools-json-cut"}
        ref={el}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </Fold>
  );
}

export function ToolRow({
  tool,
  open,
  onToggle,
  offered,
}: {
  tool: BuiltinToolSummary | WebToolSummary;
  open: boolean;
  onToggle: () => void;
  // the Config board's list: Off while no turn is offered it
  offered?: boolean;
}) {
  const builtin = "when" in tool ? tool : null;
  const board = offered !== undefined;
  const on = offered ?? ("enabled" in tool ? tool.enabled : true);
  return (
    <RowsOpen
      open={open}
      onToggle={onToggle}
      indent="chevron"
      off={!on}
      head={
        <>
          <RowsTitle
            name={tool.name}
            sub={firstSentence(tool.description)}
            mono
            subWide={!board && builtin === null}
          />
          <RowsMeta short={board || builtin ? undefined : ""}>
            {on ? tokensText(tool.tokens) : "Off"}
          </RowsMeta>
        </>
      }
    >
      <div class="tools-schema">
        {builtin && (
          <>
            <div class="label">When</div>
            <div class="tools-text">{WHEN_WORDS[builtin.when]}</div>
          </>
        )}
        <div class="label">Description</div>
        <div class="tools-text">{tool.description}</div>
        {builtin?.variant && (
          <>
            <div class="label">
              Description for an automation's own memory,{" "}
              {tokensText(builtin.variant.tokens)}
            </div>
            <div class="hint">{VARIANT_WHEN_WORDS}</div>
            <div class="tools-text">{builtin.variant.description}</div>
          </>
        )}
        <div class="label">Parameters</div>
        {builtin?.names && <div class="hint">{NAMES_WORDS}</div>}
        <ToolParams
          html={tool.parametersHtml}
          lines={jsonLines(tool.parameters)}
        />
      </div>
    </RowsOpen>
  );
}
