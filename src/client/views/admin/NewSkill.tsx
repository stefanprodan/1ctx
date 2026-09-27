// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Add skill: one card with the URL, a path field when the URL is an
// archive, and for a site or an index URL a Look up that lists the
// index's entries, each with its own Add carrying the digest the index
// gave. An add opens the skill's page. The server's 400 or 502 words
// show under the field they are about: the path's under the path,
// everything else under the URL.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type {
  IndexEntry,
  SkillSummary,
} from "../../../shared/contracts/skill.ts";
import { address, navigate } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  addSkill,
  discoverSkills,
  skills,
  skillsError,
} from "../../data/skills.ts";
import { firstSentence } from "../../lib/format.ts";
import { configSkillHref } from "../../lib/hrefs.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { touch } from "../../lib/touch.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import {
  RowsEnd,
  RowsLine,
  RowsList,
  RowsMeta,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Setting, SettingHint } from "../../ui/Setting.tsx";
import {
  formKind,
  pathProblem,
  submitLabel,
  URL_HINT,
  urlProblem,
} from "./Skills.model.ts";
import "./skill-page.css";

const STEPS = [zoneStep("Config"), { label: "Skills", href: "/config/skills" }];

export function NewSkill() {
  const error = skillsError.value;
  return (
    <Page
      steps={STEPS}
      title="Add skill"
      loading={skills.value === null && error === null}
      error={error}
    >
      <Form />
    </Page>
  );
}

function Form() {
  const url = useSignal("");
  const path = useSignal("");
  const entries = useSignal<IndexEntry[] | null>(null);
  const kind = formKind(url.value);
  const form = useRef<HTMLFormElement>(null);
  // with a mouse the URL takes the caret on arrival
  const urlField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!touch()) urlField.current?.focus();
  }, []);
  // the page the add opens, unless the admin went elsewhere meanwhile
  const open = (from: string, added: SkillSummary) => {
    if (address() === from) navigate(configSkillHref(added.name));
  };
  const save = useSave(
    async () => {
      const from = address();
      const u = url.value.trim();
      // a path typed for an archive stays in the box but goes only with one
      const p = formKind(u) === "archive" ? path.value.trim() : "";
      open(from, await addSkill(p === "" ? { url: u } : { url: u, path: p }));
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
  const addEntry = (entry: IndexEntry) => {
    const from = address();
    void save.act(`add ${entry.name}`, async () => {
      open(
        from,
        await addSkill({
          url: url.value.trim(),
          name: entry.name,
          digest: entry.digest,
        }),
      );
    });
  };
  const busy = save.busy;
  const have = new Set((skills.value ?? []).map((s) => s.name));
  return (
    <form class="skill-page" ref={form} onSubmit={submit}>
      <Setting
        label="Add skill"
        foot={
          <Foot
            save={save}
            dirty={!looking && url.value.trim() !== ""}
            label={looking ? "Looking up" : submitLabel(kind)}
            start={<SettingHint>{null}</SettingHint>}
            before={
              <a class="btn" href="/config/skills">
                Cancel
              </a>
            }
          />
        }
      >
        <div class="skill-page-fields">
          <label class="field">
            <span class="label label-required">URL</span>
            <input
              name="url"
              ref={urlField}
              aria-required="true"
              class="skill-page-mono"
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
                class="skill-page-mono"
                autocomplete="off"
                spellcheck={false}
                placeholder="skills/name"
                aria-invalid={invalid("path") || undefined}
                disabled={busy}
                value={path.value}
                onInput={save.bind(path)}
              />
              {invalid("path") ? (
                <FieldError save={save} field="path" />
              ) : (
                <span class="hint">
                  The skill's directory inside the archive. Empty when SKILL.md
                  is at its root.
                </span>
              )}
            </label>
          )}
          {entries.value !== null &&
            (entries.value.length === 0 ? (
              <p class="skill-page-state">The index lists no skills.</p>
            ) : (
              <RowsList>
                {entries.value.map((entry) => (
                  <RowsLine key={entry.name} flush>
                    <RowsTitle
                      name={entry.name}
                      sub={firstSentence(entry.description)}
                      mono
                    />
                    {have.has(entry.name) ? (
                      <RowsMeta>Added</RowsMeta>
                    ) : (
                      <RowsEnd>
                        <button
                          type="button"
                          class="btn btn-small"
                          disabled={busy}
                          onClick={() => addEntry(entry)}
                        >
                          {save.pending.value === `add ${entry.name}`
                            ? "Adding"
                            : "Add"}
                        </button>
                      </RowsEnd>
                    )}
                  </RowsLine>
                ))}
              </RowsList>
            ))}
        </div>
      </Setting>
    </form>
  );
}
