// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The hosts a visual may load scripts, styles and fonts from, as one
// form: a box of origins, one per line, saved whole, and Reset to
// defaults, which saves the list a fresh instance starts with. The box
// shows the server's list until someone types, so a save shows the
// origins as the server wrote them.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { DEFAULT_VISUAL_HOSTS } from "../../../shared/contracts/tool.ts";
import { MAX_VISUAL_HOSTS } from "../../../shared/visual.ts";
import { patchTool, tools } from "../../data/tools.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { RowsCard, RowsNote } from "../../ui/Rows.tsx";
import {
  defaultHosts,
  hostsFieldOf,
  hostsLine,
  hostsOf,
} from "./Tools.model.ts";
import "./tools.css";

export function VisualHostsCard() {
  const visual = tools.value?.visualize;
  const text = useSignal<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  // the box as it shows, read by the save built once
  const shown = useRef("");
  const save = useSave(async () => {
    const parsed = hostsOf(shown.current);
    if ("error" in parsed) return;
    await patchTool("visualize", { hosts: parsed.hosts });
    text.value = null;
  }, hostsFieldOf);
  useFocusField(save, form);
  if (!visual) return null;

  const saved = visual.hosts.join("\n");
  const typed = text.value ?? saved;
  shown.current = typed;
  const busy = save.busy;
  const invalid = save.fieldError("hosts") !== null;
  const reset = () =>
    save.act("reset the hosts", async () => {
      await patchTool("visualize", { hosts: [...DEFAULT_VISUAL_HOSTS] });
      text.value = null;
    });
  return (
    <RowsCard
      label="Allowed hosts"
      hint={`${visual.hosts.length} of ${MAX_VISUAL_HOSTS}`}
    >
      <RowsNote>{hostsLine(visual.hosts)}</RowsNote>
      <form
        class="tools-lines"
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = hostsOf(typed);
          void save.run("error" in parsed ? at("hosts", parsed.error) : null);
        }}
      >
        <label class="field">
          <textarea
            name="hosts"
            class="tools-lines-box"
            aria-label="Allowed hosts"
            rows={6}
            spellcheck={false}
            autocomplete="off"
            placeholder="https://cdn.example.com"
            value={typed}
            disabled={busy}
            aria-invalid={invalid || undefined}
            onInput={(event) => {
              text.value = (event.currentTarget as HTMLTextAreaElement).value;
              save.touch();
            }}
          />
          {invalid && <FieldError save={save} field="hosts" />}
        </label>
        <Foot
          save={save}
          dirty={typed.trim() !== saved}
          label="Save"
          start={
            <button
              type="button"
              class="btn"
              disabled={busy || defaultHosts(visual.hosts)}
              onClick={() => void reset()}
            >
              {save.pending.value === "reset the hosts"
                ? "Resetting"
                : "Reset to defaults"}
            </button>
          }
        />
      </form>
    </RowsCard>
  );
}
