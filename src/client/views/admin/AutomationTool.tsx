// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Config board's switch for the automation tool, drawn as the SMTP
// page's email switch is: a flip saves only on Save, and the row below
// opens the schema.

import { useSignal } from "@preact/signals";
import type { AutomationToolSummary } from "../../../shared/contracts/tool.ts";
import { patchTool } from "../../data/tools.ts";
import { useSave } from "../../lib/save.ts";
import { RowsSwitch } from "../../ui/Rows.tsx";
import { Setting, SettingForm } from "../../ui/Setting.tsx";
import { automationLine } from "./Config.model.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLatest } from "./drafts.ts";
import { ToolRow } from "./ToolRow.tsx";

const TITLE = "Agents manage scheduled tasks";

export function AutomationTool({ tool }: { tool: AutomationToolSummary }) {
  const drafted = useSignal<boolean | null>(null);
  const open = useSignal(false);
  const latest = useLatest(tool);
  const save = useSave(async () => {
    const enabled = drafted.value ?? latest.current.enabled;
    await patchTool("automation", { enabled });
    drafted.value = null;
  });
  const on = drafted.value ?? tool.enabled;
  return (
    <SettingForm save={save}>
      <Setting
        title={TITLE}
        line={automationLine(on)}
        list
        action={
          <RowsSwitch
            on={on}
            label={TITLE}
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
