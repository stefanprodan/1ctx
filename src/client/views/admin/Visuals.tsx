// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
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
import { at, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsSwitch } from "../../ui/Rows.tsx";
import { Setting, SettingForm, SettingStack } from "../../ui/Setting.tsx";
import { AsideLine, Split } from "../../ui/Split.tsx";
import { UsageSection } from "./AdminAside.tsx";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLatest } from "./drafts.ts";
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
          <SettingStack>
            <Switch tool={state.visualize} />
            <Hosts tool={state.visualize} />
            <LimitsSetting
              rows={rows}
              names={VISUAL_LIMITS}
              line="How much one turn may draw."
            />
          </SettingStack>
        </Split>
      )}
    </Page>
  );
}

// a flip saves only on Save; the draft is null until one, so a load
// that lands after the first draw shows through
function Switch({ tool }: { tool: WebToolSummary }) {
  const drafted = useSignal<boolean | null>(null);
  const open = useSignal(false);
  const latest = useLatest(tool);
  const save = useSave(async () => {
    const enabled = drafted.value ?? latest.current.enabled;
    await patchTool("visualize", { enabled });
    drafted.value = null;
  });
  const on = drafted.value ?? tool.enabled;
  return (
    <SettingForm save={save}>
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
            dirty={on !== tool.enabled}
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
    </SettingForm>
  );
}

// null until typing, so the box shows the list as the server wrote it
function Hosts({ tool }: { tool: WebToolSummary }) {
  const drafted = useSignal<string | null>(null);
  const latest = useLatest(tool);
  const save = useSave(async () => {
    const parsed = hostsOf(drafted.value ?? hostsText(latest.current.hosts));
    if ("error" in parsed) return;
    await patchTool("visualize", { hosts: parsed.hosts });
    drafted.value = null;
  }, hostsFieldOf);
  const typed = drafted.value ?? hostsText(tool.hosts);
  const invalid = save.fieldError("hosts") !== null;
  return (
    <SettingForm
      save={save}
      check={() => {
        const parsed = hostsOf(typed);
        return "error" in parsed ? at("hosts", parsed.error) : null;
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
    </SettingForm>
  );
}

function Aside() {
  return (
    <UsageSection value={visualsUsage.value()}>
      {(usage) => (
        <>
          <AsideLine label="Drawn">{count(usage.drawn)}</AsideLine>
          <AsideLine label="Failed">{count(usage.failed)}</AsideLine>
          <AsideLine label="Files opened">{count(usage.opened)}</AsideLine>
        </>
      )}
    </UsageSection>
  );
}
