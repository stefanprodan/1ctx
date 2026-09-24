// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A tool's row, built like every admin row: the name over the first
// sentence of its description, for a built-in the tokens its schema
// costs as the row's meta, and for a web tool its switch. It opens in place to when a send
// carries it, the text and the parameters the model gets. The hosts
// form keeps the server's list rather than normalizing a second copy.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type {
  BuiltinToolSummary,
  WebToolSummary,
} from "../../../shared/contracts/tool.ts";
import { patchTool } from "../../data/tools.ts";
import { says } from "../../lib/format.ts";
import { useCut } from "../../lib/resize.ts";
import { useFocusField, useSave } from "../../lib/save.ts";
import { copyCode } from "../../transcript/copy.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import {
  RowsEnd,
  RowsLine,
  RowsList,
  RowsListHead,
  RowsMeta,
  RowsNote,
  RowsOpen,
  RowsSwitch,
  RowsTitle,
} from "../../ui/Rows.tsx";
import {
  editHosts,
  firstSentence,
  hostsFieldOf,
  NAMES_WORDS,
  tokensText,
  VARIANT_WHEN_WORDS,
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
      failure.value = says(err);
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

function Hosts({ tool }: { tool: WebToolSummary }) {
  const host = useSignal("");
  const form = useRef<HTMLFormElement>(null);
  const latest = useRef(tool);
  latest.current = tool;
  const save = useSave(async () => {
    await patchTool("visualize", {
      hosts: editHosts(latest.current.hosts, {
        type: "add",
        host: host.value,
      }),
    });
    host.value = "";
  }, hostsFieldOf);
  useFocusField(save, form);
  const busy = save.busy;
  const invalid = save.fieldError("hosts") !== null;
  return (
    <form
      class="tools-hosts"
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        if (host.value.trim() !== "") void save.run(null);
      }}
    >
      <div>
        <RowsListHead label="Allowed hosts" />
        <RowsList>
          {tool.hosts.length === 0 ? (
            <RowsNote>No hosts allowed. Visuals use inline code only.</RowsNote>
          ) : (
            tool.hosts.map((origin) => {
              const action = `remove ${origin}`;
              return (
                <RowsLine key={origin} flush>
                  <RowsTitle name={origin} mono />
                  <RowsEnd>
                    <button
                      type="button"
                      class="btn btn-small"
                      aria-label={`Remove ${origin}`}
                      disabled={busy}
                      onClick={() =>
                        void save.act(action, () =>
                          patchTool("visualize", {
                            hosts: editHosts(latest.current.hosts, {
                              type: "remove",
                              host: origin,
                            }),
                          }),
                        )
                      }
                    >
                      {save.pending.value === action ? "Removing" : "Remove"}
                    </button>
                  </RowsEnd>
                </RowsLine>
              );
            })
          )}
        </RowsList>
      </div>
      <label class="field">
        <span class="label">Host</span>
        <input
          name="hosts"
          autocomplete="off"
          spellcheck={false}
          placeholder="https://cdn.example.com"
          value={host.value}
          disabled={busy}
          aria-invalid={invalid || undefined}
          onInput={(event) => {
            host.value = (event.currentTarget as HTMLInputElement).value;
            save.touch();
          }}
        />
        {invalid ? (
          <FieldError save={save} field="hosts" />
        ) : (
          <span class="hint">
            Allowed hosts receive whatever a visual puts in its URLs.
          </span>
        )}
      </label>
      <Foot
        save={save}
        dirty={host.value.trim() !== ""}
        label="Add"
        start={
          <button
            type="button"
            class="btn"
            disabled={busy}
            onClick={() =>
              void save.act("reset the hosts", () =>
                patchTool("visualize", {
                  hosts: editHosts(latest.current.hosts, { type: "reset" }),
                }),
              )
            }
          >
            {save.pending.value === "reset the hosts" ? "Resetting" : "Reset"}
          </button>
        }
      />
    </form>
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
  // the parameters are cut to a height with Show all, since a box that
  // scrolls on its own inside the page's scroll leaves the page's
  // sticky head behind
  const {
    el: json,
    open: all,
    long,
  } = useCut<HTMLDivElement>([open, tool.parametersHtml]);
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
        {"enabled" in tool && tool.name === "visualize" && (
          <Hosts tool={tool} />
        )}
        {builtin && (
          <>
            <div class="label">When</div>
            <div class="tools-text">{WHEN_WORDS[builtin.when]}</div>
          </>
        )}
        <div class="label">Description for agents</div>
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
        <div
          class={all.value ? undefined : "tools-json-cut"}
          ref={json}
          dangerouslySetInnerHTML={{ __html: tool.parametersHtml }}
        />
        {long.value && (
          <button
            type="button"
            class="btn btn-small tools-toggle"
            aria-expanded={all.value}
            onClick={() => {
              all.value = !all.value;
            }}
          >
            {all.value ? "Show less" : "Show all"}
          </button>
        )}
      </div>
    </RowsOpen>
  );
}
