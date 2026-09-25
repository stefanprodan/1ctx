// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The CDNs a visual may load scripts, styles and fonts from, as one
// section: a box of origins, one per line, saved whole, and Reset to
// defaults, which saves the list a fresh instance starts with, the
// count of what the box holds at the end of the buttons' line. The box
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
import { Section, SectionForm } from "../../ui/Section.tsx";
import {
  defaultHosts,
  hostsCount,
  hostsFieldOf,
  hostsLine,
  hostsOf,
} from "./Tools.model.ts";

// off while visualize is: the list stays as saved and cannot change
export function VisualHosts({ off }: { off: boolean }) {
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
  const busy = save.busy || off;
  const invalid = save.fieldError("hosts") !== null;
  const submit = (event: Event) => {
    event.preventDefault();
    const parsed = hostsOf(typed);
    void save.run("error" in parsed ? at("hosts", parsed.error) : null);
  };
  const reset = () =>
    save.act("reset the hosts", async () => {
      await patchTool("visualize", { hosts: [...DEFAULT_VISUAL_HOSTS] });
      text.value = null;
    });
  return (
    <Section title="CDNs" text={hostsLine(visual.hosts)} off={off}>
      <SectionForm onSubmit={submit} formRef={form}>
        <label class="field">
          <textarea
            name="hosts"
            class="section-lines"
            aria-label="CDNs"
            rows={Math.max(4, typed.split("\n").length + 1)}
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
          <FieldError save={save} field="hosts" />
        </label>
        <Foot
          save={save}
          dirty={!off && typed.trim() !== saved}
          label="Save"
          after={
            <>
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
              <span class="section-fact section-fact-end">
                {hostsCount(typed)} of {MAX_VISUAL_HOSTS}
              </span>
            </>
          }
        />
      </SectionForm>
    </Section>
  );
}
