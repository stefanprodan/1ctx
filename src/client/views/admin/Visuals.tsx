// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Config › Visuals, a settings page: the switch over the visualize tool
// it offers, the CDNs a visual may load from, and how much one turn may
// draw, each a card that drafts and saves apart; the aside has the last
// 30 days. Nothing saves before Save, the switch included. A change
// applies to the next turn.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { LimitRow } from "../../../shared/contracts/limit.ts";
import type { WebToolSummary } from "../../../shared/contracts/tool.ts";
import { MAX_VISUAL_HOSTS } from "../../../shared/visual.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  limits,
  patchTool,
  tools,
  toolsError,
  visualsUsage,
} from "../../data/tools.ts";
import { count } from "../../lib/format.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { NumberBox } from "../../ui/NumberBox.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsSwitch } from "../../ui/Rows.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLimitsForm } from "./LimitsCard.tsx";
import { ToolRow } from "./ToolRow.tsx";
import {
  defaultLine,
  displayOf,
  hostsCount,
  hostsFieldOf,
  hostsLine,
  hostsOf,
  LIMIT_WORDS,
  dirty as limitsDirty,
  show,
} from "./Tools.model.ts";
import {
  hostsDirty,
  hostsText,
  isDefaultHosts,
  VISUAL_LIMITS,
  visualsLine,
} from "./Visuals.model.ts";
import "./visuals.css";

export function Visuals() {
  const state = tools.value;
  const rows = limits.value;
  const error = toolsError.value;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Visuals"
      split
      loading={(state === null || rows === null) && error === null}
      error={error}
    >
      {state && rows && (
        <Split aside={<Aside />}>
          <div class="visuals">
            <Switch tool={state.visualize} />
            <Hosts tool={state.visualize} />
            <Limits rows={rows} />
          </div>
        </Split>
      )}
    </Page>
  );
}

// the switch in the head, the tool it offers as the card's one row. The
// draft is null until a flip, so the switch shows what was saved, a
// load that lands after the first draw included
function Switch({ tool }: { tool: WebToolSummary }) {
  const drafted = useSignal<boolean | null>(null);
  const open = useSignal(false);
  const latest = useRef(tool);
  latest.current = tool;
  const save = useSave(async () => {
    const enabled = drafted.value ?? latest.current.enabled;
    await patchTool("visualize", { enabled });
    drafted.value = null;
  });
  const on = drafted.value ?? tool.enabled;
  const dirty = on !== tool.enabled;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
      <Setting
        title="Visuals"
        line={visualsLine(tool.enabled)}
        list
        action={
          <RowsSwitch
            on={on}
            label="Visuals"
            disabled={save.busy}
            onClick={() => {
              drafted.value = !on;
              save.touch();
            }}
          />
        }
        foot={
          <DraftFoot
            save={save}
            dirty={dirty}
            onDiscard={() => {
              drafted.value = null;
            }}
          />
        }
      >
        <ToolRow
          tool={tool}
          open={open.value}
          onToggle={() => {
            open.value = !open.value;
          }}
        />
      </Setting>
    </form>
  );
}

// a box of origins, one per line, saved whole; Use defaults puts the
// list a fresh instance starts with in the box. The draft is null until
// someone types, so the box shows the saved list as the server wrote it
function Hosts({ tool }: { tool: WebToolSummary }) {
  const drafted = useSignal<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const latest = useRef(tool);
  latest.current = tool;
  const save = useSave(async () => {
    const parsed = hostsOf(drafted.value ?? hostsText(latest.current.hosts));
    if ("error" in parsed) return;
    await patchTool("visualize", { hosts: parsed.hosts });
    drafted.value = null;
  }, hostsFieldOf);
  useFocusField(save, form);
  const typed = drafted.value ?? hostsText(tool.hosts);
  const invalid = save.fieldError("hosts") !== null;
  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = hostsOf(typed);
        void save.run("error" in parsed ? at("hosts", parsed.error) : null);
      }}
    >
      <Setting
        title="CDNs"
        count={`${hostsCount(typed)} of ${MAX_VISUAL_HOSTS}`}
        line={hostsLine(tool.hosts)}
        action={
          <button
            type="button"
            class="btn btn-small"
            disabled={save.busy || isDefaultHosts(typed)}
            onClick={() => {
              drafted.value = hostsText();
              save.touch();
            }}
          >
            Use defaults
          </button>
        }
        foot={
          <DraftFoot
            save={save}
            dirty={hostsDirty(typed, tool.hosts)}
            onDiscard={() => {
              drafted.value = null;
            }}
          />
        }
      >
        <label class="field">
          <textarea
            name="hosts"
            class="visuals-hosts"
            aria-label="CDNs"
            rows={Math.max(4, typed.split("\n").length + 1)}
            spellcheck={false}
            autocomplete="off"
            placeholder="https://cdn.example.com"
            value={typed}
            disabled={save.busy}
            aria-invalid={invalid || undefined}
            onInput={(event) => {
              drafted.value = (
                event.currentTarget as HTMLTextAreaElement
              ).value;
              save.touch();
            }}
          />
          <FieldError save={save} field="hosts" />
        </label>
      </Setting>
    </form>
  );
}

// the three visual limits side by side, each with its default beside a
// changed one; Use defaults puts the defaults in the boxes
function Limits({ rows }: { rows: LimitRow[] }) {
  const { own, draft, form, save, submit, type, defaults, discard } =
    useLimitsForm(rows, VISUAL_LIMITS);
  const atDefaults = own.every(
    (row) => draft.value[row.name] === show(row, row.default),
  );
  return (
    <form ref={form} onSubmit={submit}>
      <Setting
        title="Limits"
        line="How much one turn may draw."
        action={
          <button
            type="button"
            class="btn btn-small"
            disabled={save.busy || atDefaults}
            onClick={defaults}
          >
            Use defaults
          </button>
        }
        foot={
          <DraftFoot
            save={save}
            dirty={limitsDirty(own, draft.value)}
            onDiscard={discard}
          />
        }
      >
        <div class="visuals-limits">
          {own.map((row) => {
            const words = LIMIT_WORDS[row.name];
            const error = save.fieldError(row.name);
            return (
              <label key={row.name} class="field">
                <span class="visuals-label">
                  <span class="label">{words.label}</span>
                  {row.changedAt !== null && (
                    <span class="hint">{defaultLine(row)}</span>
                  )}
                </span>
                <NumberBox
                  name={row.name}
                  value={draft.value[row.name] ?? ""}
                  unit={displayOf(row).word}
                  invalid={error !== null}
                  disabled={save.busy}
                  onInput={(text) => type(row.name, text)}
                />
                {error !== null ? (
                  <FieldError save={save} field={row.name} />
                ) : (
                  <span class="hint">{words.text}</span>
                )}
              </label>
            );
          })}
        </div>
      </Setting>
    </form>
  );
}

function Aside() {
  const known = visualsUsage.value;
  const usage = known?.usage ?? null;
  return (
    <AsideSection label="Last 30 days">
      {known === null ? (
        <p class="split-empty">Loading</p>
      ) : usage === null ? (
        <p class="split-empty">Did not load.</p>
      ) : (
        <>
          <AsideLine label="Drawn">{count(usage.drawn)}</AsideLine>
          <AsideLine label="Failed">{count(usage.failed)}</AsideLine>
          <AsideLine label="Files opened">{count(usage.opened)}</AsideLine>
        </>
      )}
    </AsideSection>
  );
}
