// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  BuiltinToolSummary,
  EmailToolSummary,
  WebToolSummary,
} from "../../../shared/contracts/tool.ts";
import { firstSentence, tokensText } from "../../lib/format.ts";
import { RowsMeta, RowsOpen, RowsTitle } from "../../ui/Rows.tsx";
import { ToolParams } from "./ToolParams.tsx";
import { NAMES_WORDS, VARIANT_WHEN_WORDS, WHEN_WORDS } from "./Tools.model.ts";
import "./tools.css";

export function ToolRow({
  tool,
  open,
  onToggle,
  offered,
}: {
  tool: BuiltinToolSummary | WebToolSummary | EmailToolSummary;
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
        <ToolParams tool={tool} />
      </div>
    </RowsOpen>
  );
}
