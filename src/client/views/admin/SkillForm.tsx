// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Add skill: one URL field, a path field when the URL is an archive,
// and for a site or an index URL a Look up that lists the index's
// entries, each with its own Add carrying the digest the index gave.
// The server's 400 or 502 words show under the field.

import { useSignal } from "@preact/signals";
import type { IndexEntry } from "../../../shared/contracts/skill.ts";
import { addSkill, discoverSkills, skills } from "../../data/skills.ts";
import { reason } from "../../lib/format.ts";
import { useSave } from "../../lib/save.ts";
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
  const adding = useSignal<string | null>(null);
  const failure = useSignal<string | null>(null);
  const looking = useSignal(false);
  const kind = formKind(url.value);
  const save = useSave(async () => {
    const u = url.value.trim();
    // a path typed for an archive stays in the box but goes only with one
    const p = formKind(u) === "archive" ? path.value.trim() : "";
    await addSkill(p === "" ? { url: u } : { url: u, path: p });
    onDone();
  });
  // a site or an index is looked up, not saved: the entries show under
  // the field and each carries its own Add
  const lookUp = async () => {
    looking.value = true;
    failure.value = null;
    try {
      entries.value = await discoverSkills(url.value.trim());
    } catch (err) {
      failure.value = reason(err);
    }
    looking.value = false;
  };
  const submit = (event: Event) => {
    event.preventDefault();
    const problem = urlProblem(url.value);
    if (kind === "index") {
      if (problem === null) void lookUp();
      return;
    }
    void save.run(
      problem ?? (kind === "archive" ? pathProblem(path.value) : null),
    );
  };
  const addEntry = async (entry: IndexEntry) => {
    adding.value = entry.name;
    failure.value = null;
    try {
      await addSkill({
        url: url.value.trim(),
        name: entry.name,
        digest: entry.digest,
      });
      onDone();
    } catch (err) {
      failure.value = reason(err);
      adding.value = null;
    }
  };
  const busy =
    save.status.value === "busy" || adding.value !== null || looking.value;
  const have = new Set((skills.value ?? []).map((s) => s.name));
  return (
    <form class="skills-form" onSubmit={submit}>
      <div class="skills-fields">
        <label class="field">
          <span class="label">URL</span>
          <input
            name="url"
            class="skills-url"
            autocomplete="off"
            spellcheck={false}
            placeholder="https://github.com/org/repo/tree/main/skills/name"
            disabled={busy}
            value={url.value}
            onInput={(e) => {
              url.value = (e.currentTarget as HTMLInputElement).value;
              entries.value = null;
              failure.value = null;
              save.touch();
            }}
          />
          <span class="hint">{URL_HINT}</span>
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
              disabled={busy}
              value={path.value}
              onInput={(e) => {
                path.value = (e.currentTarget as HTMLInputElement).value;
                save.touch();
              }}
            />
            <span class="hint">
              The skill's directory inside the archive. Empty when SKILL.md is
              at its root.
            </span>
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
                      {adding.value === entry.name ? "Adding" : "Add"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        {failure.value && <p class="skills-state error">{failure.value}</p>}
      </div>
      <Foot
        status={save.status.value}
        dirty={!looking.value}
        label={looking.value ? "Looking up" : submitLabel(kind)}
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
