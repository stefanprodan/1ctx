// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Add skill: one URL field, a path field when the URL is an archive,
// and for a site or an index URL a Look up that lists the index's
// entries, each with its own Add carrying the digest the index gave.
// The server's 400 or 502 words show under the field they are about:
// the path's under the path, everything else under the URL.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { IndexEntry } from "../../../shared/contracts/skill.ts";
import { addSkill, discoverSkills, skills } from "../../data/skills.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import {
  firstSentence,
  formKind,
  pathProblem,
  submitLabel,
  URL_HINT,
  urlProblem,
} from "./Skills.model.ts";
import "./skills.css";

export function SkillForm({ onDone }: { onDone: () => void }) {
  const url = useSignal("");
  const path = useSignal("");
  const entries = useSignal<IndexEntry[] | null>(null);
  const kind = formKind(url.value);
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(
    async () => {
      const u = url.value.trim();
      // a path typed for an archive stays in the box but goes only with one
      const p = formKind(u) === "archive" ? path.value.trim() : "";
      await addSkill(p === "" ? { url: u } : { url: u, path: p });
      onDone();
    },
    (message) => (message.startsWith("path") ? "path" : "url"),
  );
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const looking = save.pending.value === "look up";
  // a site or an index is looked up, not saved: the entries show under
  // the field and each carries its own Add
  const lookUp = () =>
    save.act("look up", async () => {
      entries.value = await discoverSkills(url.value.trim());
    });
  const submit = (event: Event) => {
    event.preventDefault();
    const problem = at("url", urlProblem(url.value));
    if (kind === "index") {
      if (problem === null) void lookUp();
      else void save.run(problem);
      return;
    }
    void save.run(
      problem ??
        (kind === "archive" ? at("path", pathProblem(path.value)) : null),
    );
  };
  const addEntry = async (entry: IndexEntry) => {
    const added = await save.act(`add ${entry.name}`, () =>
      addSkill({
        url: url.value.trim(),
        name: entry.name,
        digest: entry.digest,
      }),
    );
    if (added) onDone();
  };
  const busy = save.busy;
  const have = new Set((skills.value ?? []).map((s) => s.name));
  return (
    <form class="skills-form" ref={form} onSubmit={submit}>
      <div class="skills-fields">
        <label class="field">
          <span class="label label-required">URL</span>
          <input
            name="url"
            aria-required="true"
            class="skills-url"
            autocomplete="off"
            spellcheck={false}
            placeholder="https://github.com/org/repo/tree/main/skills/name"
            aria-invalid={invalid("url") || undefined}
            disabled={busy}
            value={url.value}
            onInput={(e) => {
              url.value = (e.currentTarget as HTMLInputElement).value;
              entries.value = null;
              save.touch();
            }}
          />
          {invalid("url") ? (
            <FieldError save={save} field="url" />
          ) : (
            <span class="hint">{URL_HINT}</span>
          )}
        </label>
        {kind === "archive" && (
          <label class="field">
            <span class="label">Path</span>
            <input
              name="path"
              class="skills-url"
              autocomplete="off"
              spellcheck={false}
              placeholder="skills/name"
              aria-invalid={invalid("path") || undefined}
              disabled={busy}
              value={path.value}
              onInput={(e) => {
                path.value = (e.currentTarget as HTMLInputElement).value;
                save.touch();
              }}
            />
            {invalid("path") ? (
              <FieldError save={save} field="path" />
            ) : (
              <span class="hint">
                The skill's directory inside the archive. Empty when SKILL.md is
                at its root.
              </span>
            )}
          </label>
        )}
        {entries.value !== null &&
          (entries.value.length === 0 ? (
            <p class="skills-state">The index lists no skills.</p>
          ) : (
            <div class="skills-entries">
              {entries.value.map((entry) => (
                <div key={entry.name} class="skills-entry">
                  <span class="skills-entry-name">{entry.name}</span>
                  <span class="skills-entry-desc">
                    {firstSentence(entry.description)}
                  </span>
                  {have.has(entry.name) ? (
                    <span class="skills-entry-added">Added</span>
                  ) : (
                    <button
                      type="button"
                      class="btn btn-small"
                      disabled={busy}
                      onClick={() => void addEntry(entry)}
                    >
                      {save.pending.value === `add ${entry.name}`
                        ? "Adding"
                        : "Add"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
      </div>
      <Foot
        save={save}
        dirty={!looking}
        label={looking ? "Looking up" : submitLabel(kind)}
        start={<span />}
        before={
          <button type="button" class="btn" onClick={onDone}>
            Cancel
          </button>
        }
      />
    </form>
  );
}
