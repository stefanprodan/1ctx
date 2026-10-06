// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The SMTP page's switch for email_user, drawn as the Visuals switch
// is: a flip saves only on Save, and the row below opens the schema.

import { useSignal } from "@preact/signals";
import type { EmailToolSummary } from "../../../shared/contracts/tool.ts";
import { patchTool } from "../../data/tools.ts";
import { useSave } from "../../lib/save.ts";
import { RowsSwitch } from "../../ui/Rows.tsx";
import { Setting, SettingForm } from "../../ui/Setting.tsx";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLatest } from "./drafts.ts";
import { agentEmailLine } from "./Smtp.model.ts";
import { ToolRow } from "./ToolRow.tsx";

const TITLE = "Agents email users";

// emailOn is the page's own word on the server, fresher than the tool's
export function AgentEmail({
  tool,
  emailOn,
}: {
  tool: EmailToolSummary;
  emailOn: boolean;
}) {
  const drafted = useSignal<boolean | null>(null);
  const open = useSignal(false);
  const latest = useLatest(tool);
  const save = useSave(async () => {
    const enabled = drafted.value ?? latest.current.enabled;
    await patchTool("email_user", { enabled });
    drafted.value = null;
  });
  const on = drafted.value ?? tool.enabled;
  return (
    <SettingForm save={save}>
      <Setting
        title={TITLE}
        line={agentEmailLine(on, emailOn)}
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
          tool={{ ...tool, enabled: on && emailOn }}
          open={open.value}
          onToggle={() => {
            open.value = !open.value;
          }}
        />
      </Setting>
    </SettingForm>
  );
}
