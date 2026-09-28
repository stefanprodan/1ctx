// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A tool's row, built like every admin row: the name over the first
// sentence of its description, the tokens its schema costs as the
// row's meta, Off in its place while no turn is offered it, and on the
// Visuals page only from 720 up. It opens in place to when a send
// carries it, the text and the parameters the model gets.

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
  // the parameters are cut to a height, Show all at the block's foot,
  // since a box that scrolls on its own inside the page's scroll leaves
  // the page's sticky head behind; once open the block stays whole
  // until the row folds
  const {
    el: json,
    open: all,
    long,
  } = useCut<HTMLDivElement>([open, tool.parametersHtml]);
  useEffect(() => {
    if (!open) all.value = false;
  }, [open]);
  // the block's Copy is a button inside rendered HTML, so the click is
  // delegated the way the transcript does it
  useEffect(() => {
    const el = json.current;
    if (!el) return;
    const on = (ev: MouseEvent) => void copyCode(ev);
    el.addEventListener("click", on);
    return () => el.removeEventListener("click", on);
  }, [open]);
  const builtin = "when" in tool ? tool : null;
  // on the Config board the board says; elsewhere visualize's switch
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
          {board || builtin ? (
            <RowsMeta>{on ? tokensText(tool.tokens) : "Off"}</RowsMeta>
          ) : (
            <RowsMeta short="">{on ? tokensText(tool.tokens) : "Off"}</RowsMeta>
          )}
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
        {/* Server rendering keeps the Markdown parser out of the browser. */}
        <Fold
          cut={long.value && !all.value}
          onOpen={() => {
            all.value = true;
          }}
          label={showAll(jsonLines(tool.parameters))}
          framed
        >
          <div
            class={all.value ? undefined : "tools-json-cut"}
            ref={json}
            dangerouslySetInnerHTML={{ __html: tool.parametersHtml }}
          />
        </Fold>
      </div>
    </RowsOpen>
  );
}
