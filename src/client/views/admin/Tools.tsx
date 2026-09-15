// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tools: three cards. The built-ins, a row each with its switch,
// opening in place to the text and the parameters the model gets,
// read-only. The search provider, one of two, with whether its key
// file is there. The limits, per send and per call, each typed in the
// page's unit with the default beside a changed one; Save and Reset
// to defaults at the foot. A change applies to the next send.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { LimitRow } from "../../../shared/contracts/limit.ts";
import type { ToolSummary } from "../../../shared/contracts/tool.ts";
import {
  type LimitScope,
  SEARCH_PROVIDERS,
  type SearchProvider,
} from "../../../shared/words.ts";
import {
  limits,
  patchTool,
  resetLimits,
  saveLimits,
  tools,
  toolsError,
} from "../../data/tools.ts";
import { useFocusField, useSave } from "../../lib/save.ts";
import { copyCode } from "../../transcript/copy.ts";
import { Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsCard,
  RowsLine,
  RowsMeta,
  RowsNote,
  RowsOpen,
  RowsTitle,
} from "../../ui/Rows.tsx";
import {
  collect,
  defaultLine,
  dirty,
  displayOf,
  draftOf,
  firstSentence,
  keyLine,
  LIMIT_WORDS,
  limitFieldOf,
  searchLine,
  TOOL_WORDS,
} from "./Tools.model.ts";
import "../../transcript/hljs.css";
import "../../transcript/md.css";
import "./tools.css";
import { reason } from "../../lib/format.ts";

// a built-in: the row with its switch, the schema under it when open
function ToolRow({
  tool,
  open,
  onToggle,
}: {
  tool: ToolSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const busy = useSignal(false);
  const failure = useSignal<string | null>(null);
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
    <RowsOpen
      open={open}
      onToggle={onToggle}
      indent="chevron"
      head={
        <>
          <span class="tools-name">{tool.name}</span>
          <span class="tools-desc">
            {firstSentence(tool.description) || TOOL_WORDS[tool.name]}
          </span>
        </>
      }
      end={
        <>
          {failure.value && (
            <span class="tools-note error">{failure.value}</span>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={tool.enabled}
            aria-label={`${tool.name} ${tool.enabled ? "on" : "off"}`}
            class={`tools-switch${tool.enabled ? " tools-switch-on" : ""}`}
            disabled={busy.value}
            onClick={() => void flip()}
          >
            <span class="tools-switch-knob" />
          </button>
        </>
      }
    >
      <div class="tools-schema">
        <div class="tools-label">Description for agents</div>
        <div class="tools-text">{tool.description}</div>
        <div class="tools-label">Parameters</div>
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

// the two providers as radio rows; a pick writes at once
function SearchCard() {
  const state = tools.value?.search;
  const busy = useSignal(false);
  const failure = useSignal<string | null>(null);
  if (!state) return null;
  const choose = async (provider: SearchProvider) => {
    if (provider === state.provider || busy.value) return;
    busy.value = true;
    failure.value = null;
    try {
      await patchTool("websearch", { provider });
    } catch (err) {
      failure.value = reason(err);
    }
    busy.value = false;
  };
  return (
    <RowsCard label="Web search">
      {SEARCH_PROVIDERS.map((provider) => (
        <RowsLine key={provider} as="label" flush>
          <input
            class="tools-radio"
            type="radio"
            name="search"
            value={provider}
            checked={state.provider === provider}
            disabled={busy.value}
            onChange={() => void choose(provider)}
          />
          <RowsTitle name={provider} mono />
          <RowsMeta>{keyLine(provider, state.keys[provider])}</RowsMeta>
        </RowsLine>
      ))}
      <RowsNote>
        {failure.value ? (
          <span class="error">{failure.value}</span>
        ) : (
          searchLine(state)
        )}
      </RowsNote>
    </RowsCard>
  );
}

function LimitField({
  row,
  text,
  busy,
  error,
  onInput,
}: {
  row: LimitRow;
  text: string;
  busy: boolean;
  // a refusal that names this limit
  error: string | null;
  onInput: (text: string) => void;
}) {
  const { word } = displayOf(row);
  const words = LIMIT_WORDS[row.name];
  return (
    <label class="tools-limit">
      <span class="tools-limit-words">
        <span class="tools-limit-label">{words.label}</span>
        <span class="tools-limit-text">{words.text}</span>
      </span>
      <span class="tools-limit-field">
        <input
          class={`tools-input${error ? " tools-input-invalid" : ""}`}
          name={row.name}
          aria-invalid={error ? true : undefined}
          type="number"
          step="any"
          inputMode="decimal"
          autocomplete="off"
          spellcheck={false}
          disabled={busy}
          value={text}
          onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
        />
        <span class="tools-unit">{word}</span>
      </span>
      {row.changedAt !== null && (
        <span class="tools-default">{defaultLine(row)}</span>
      )}
      {error && (
        <span class="field-error tools-limit-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

// the limits form: two groups, the fields seeded from the rows and
// re-seeded when a save or a reset answers new rows
function LimitsCard({ rows }: { rows: LimitRow[] }) {
  const draft = useSignal(draftOf(rows));
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    draft.value = draftOf(rows);
  }, [rows]);
  const save = useSave(async () => {
    const got = collect(rows, draft.value);
    if ("problem" in got) throw new Error(got.problem);
    await saveLimits({ values: got.values });
  }, limitFieldOf);
  useFocusField(save, form);
  const submit = (event: Event) => {
    event.preventDefault();
    const got = collect(rows, draft.value);
    void save.run(
      "problem" in got ? { error: got.problem, field: got.field } : null,
    );
  };
  const reset = () => save.act("reset the limits", resetLimits);
  const busy = save.busy;
  const group = (scope: LimitScope, title: string) => (
    <div class="tools-group">
      <span class="label">{title}</span>
      {rows
        .filter((row) => row.scope === scope)
        .map((row) => (
          <LimitField
            key={row.name}
            row={row}
            text={draft.value[row.name] ?? ""}
            busy={busy}
            error={save.fieldError(row.name)}
            onInput={(text) => {
              draft.value = { ...draft.value, [row.name]: text };
              save.touch();
            }}
          />
        ))}
    </div>
  );
  const changed = rows.some((row) => row.changedAt !== null);
  return (
    <RowsCard label="Limits">
      <form class="tools-form" ref={form} onSubmit={submit}>
        {group("send", "Per send")}
        {group("call", "Per call")}
        <Foot
          save={save}
          dirty={dirty(rows, draft.value)}
          label="Save"
          start={
            <button
              type="button"
              class="btn"
              disabled={busy || !changed}
              onClick={() => void reset()}
            >
              {save.pending.value === "reset the limits"
                ? "Resetting"
                : "Reset to defaults"}
            </button>
          }
        />
      </form>
    </RowsCard>
  );
}

export function Tools() {
  const state = tools.value;
  const rows = limits.value;
  const open = useSignal<string | null>(null);
  const error = toolsError.value;
  return (
    <Page
      crumb="Admin"
      title="Tools"
      loading={(state === null || rows === null) && error === null}
      error={error}
    >
      <Rows>
        <RowsCard label="Built-in tools">
          {(state?.tools ?? []).map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              open={open.value === tool.name}
              onToggle={() => {
                open.value = open.value === tool.name ? null : tool.name;
              }}
            />
          ))}
        </RowsCard>
        <SearchCard />
        {rows && <LimitsCard rows={rows} />}
      </Rows>
    </Page>
  );
}
