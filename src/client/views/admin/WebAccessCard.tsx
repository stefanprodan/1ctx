// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Web access for the whole instance: off, every domain, or the hosts
// listed. The modes sit in the card's head, where a list has its filters,
// and one line under it says what the picked mode means. Off and All
// domains save on the click, as the page's switches do. Listed domains
// opens the hosts box, and the mode is saved with the list, since a list
// with no host is refused.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { WebAccessMode } from "../../../shared/web.ts";
import { patchTool, tools } from "../../data/tools.ts";
import { at, useAction, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { RowsCard, RowsFilters, RowsNote } from "../../ui/Rows.tsx";
import {
  ACCESS_MODES,
  ACCESS_WORDS,
  DOMAINS_HINT,
  domainsFieldOf,
  domainsOf,
} from "./Tools.model.ts";
import "./tools.css";

export function WebAccessCard() {
  const access = tools.value?.access;
  // Listed domains picked but not saved yet: the box is open over the
  // stored mode
  const listing = useSignal(false);
  const text = useSignal<string | null>(null);
  const { busy, failure, run } = useAction();
  const form = useRef<HTMLFormElement>(null);
  // the box as it shows, the stored list until someone types
  const shown = useRef("");
  const save = useSave(async () => {
    const parsed = domainsOf(shown.current);
    if ("error" in parsed) return;
    await patchTool("web", { mode: "listed", domains: parsed.domains });
    listing.value = false;
    text.value = null;
  }, domainsFieldOf);
  useFocusField(save, form);
  if (!access) return null;

  const mode: WebAccessMode = listing.value ? "listed" : access.mode;
  const typed = text.value ?? access.domains.join("\n");
  shown.current = typed;
  const dirty =
    access.mode !== "listed" || typed.trim() !== access.domains.join("\n");

  const pick = async (next: WebAccessMode) => {
    if (busy.value || save.busy) return;
    failure.value = null;
    if (next === "listed") {
      listing.value = access.mode !== "listed";
      return;
    }
    listing.value = false;
    text.value = null;
    if (next === access.mode) return;
    await run(() => patchTool("web", { mode: next }));
  };

  const invalid = save.fieldError("domains") !== null;
  return (
    <RowsCard
      label="Web access"
      action={
        <RowsFilters
          label="Web access"
          filters={ACCESS_MODES.map((m) => ({
            label: m.label,
            on: mode === m.value,
            onPick: () => void pick(m.value),
          }))}
        />
      }
    >
      <RowsNote>
        {failure.value ? (
          <span class="error">{failure.value}</span>
        ) : (
          ACCESS_WORDS[mode]
        )}
      </RowsNote>
      {mode === "listed" && (
        <form
          class="tools-lines"
          ref={form}
          onSubmit={(event) => {
            event.preventDefault();
            // a mode on its way must land before a list may follow it
            if (busy.value) return;
            const parsed = domainsOf(typed);
            void save.run(
              "error" in parsed ? at("domains", parsed.error) : null,
            );
          }}
        >
          <label class="field">
            <textarea
              name="domains"
              class="tools-lines-box"
              aria-label="Allowed hosts"
              rows={6}
              spellcheck={false}
              autocomplete="off"
              placeholder="docs.example.com"
              value={typed}
              disabled={save.busy || busy.value}
              aria-invalid={invalid || undefined}
              onInput={(event) => {
                text.value = (event.currentTarget as HTMLTextAreaElement).value;
                save.touch();
              }}
            />
            {invalid ? (
              <FieldError save={save} field="domains" />
            ) : (
              <span class="hint">{DOMAINS_HINT}</span>
            )}
          </label>
          <Foot save={save} dirty={dirty && !busy.value} label="Save" />
        </form>
      )}
    </RowsCard>
  );
}
