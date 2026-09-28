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
import { Page } from "../../ui/Page.tsx";
import { RowsSwitch } from "../../ui/Rows.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { DraftFoot } from "./DraftFoot.tsx";
import { LimitsSetting } from "./LimitsSetting.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { hostsCount, hostsFieldOf, hostsLine, hostsOf } from "./Tools.model.ts";
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
            <LimitsSetting
              rows={rows}
              names={VISUAL_LIMITS}
              line="How much one turn may draw."
            />
          </div>
        </Split>
      )}
    </Page>
  );
}

// the switch in the head, the tool it offers as the card's one row; the
// line and the row follow the draft, so a flip says what Save will do.
// The draft is null until a flip, so the switch shows what was saved, a
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
        line={visualsLine(on)}
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
          tool={{ ...tool, enabled: on }}
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
