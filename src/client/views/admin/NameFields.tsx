// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { AVATARS, MAX_NAME } from "../../../shared/words.ts";
import { AvatarIcon } from "../../lib/avatars.tsx";
import { shapedInput } from "../../lib/names.ts";
import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { RowsCheck } from "../../ui/Rows.tsx";
import type { AgentDrafts } from "./AgentPage.state.ts";
import "./agent-page.css";

export function NameFields({
  drafts: d,
  save,
  kept,
  fresh,
}: {
  drafts: AgentDrafts;
  save: Save;
  // the oldest while default: No hands the mark to the oldest
  kept?: boolean;
  // a new agent has no mark to set
  fresh?: boolean;
}) {
  const busy = save.busy;
  return (
    <>
      <div class="agent-page-pair">
        <label class="field agent-page-name">
          <span class="label">Name</span>
          <input
            name="name"
            autocomplete="off"
            spellcheck={false}
            maxLength={MAX_NAME}
            aria-invalid={save.fieldError("name") !== null || undefined}
            disabled={busy}
            value={d.name.value}
            onInput={(e) => {
              d.name.value = shapedInput(e);
              save.touch();
            }}
          />
          <FieldError save={save} field="name" />
        </label>
        <div class="field">
          <span class="label">Avatar</span>
          <div class="agent-page-avatars">
            {AVATARS.map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={d.avatar.value === a}
                aria-label={a}
                disabled={busy}
                class={`avatar agent-page-avatar${
                  d.avatar.value === a ? " agent-page-avatar-on" : ""
                }`}
                onClick={() => {
                  d.avatar.value = a;
                  save.touch();
                }}
              >
                <AvatarIcon name={a} size={18} />
              </button>
            ))}
          </div>
        </div>
      </div>
      <label class="field">
        <span class="label">Prompt</span>
        <textarea
          name="prompt"
          class="agent-page-prompt"
          rows={6}
          aria-invalid={save.fieldError("prompt") !== null || undefined}
          disabled={busy}
          placeholder="You are a helpful assistant. Be accurate, clear and concise."
          value={d.prompt.value}
          onInput={(e) => {
            d.prompt.value = (e.currentTarget as HTMLTextAreaElement).value;
            save.touch();
          }}
        />
        <FieldError save={save} field="prompt" />
      </label>
      {!fresh && (
        <RowsCheck
          name="default"
          checked={d.isDefault.value}
          disabled={busy || kept}
          faint={kept}
          note={kept ? "Mark another agent to move it" : undefined}
          onChange={() => {
            d.isDefault.value = !d.isDefault.value;
            save.touch();
          }}
        >
          Default for new users
        </RowsCheck>
      )}
    </>
  );
}
