// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent form's skills: the label with how many are checked, then a
// line per skill on the server with its box, the name over the first
// sentence of the description. Past the cap an unchecked line goes
// faint and takes no click.

import type { SkillSummary } from "../../../shared/contracts/skill.ts";
import { MAX_SKILLS_PER_AGENT } from "../../../shared/words.ts";
import { firstSentence } from "../../lib/format.ts";
import {
  RowsCheck,
  RowsLine,
  RowsList,
  RowsListHead,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { skillsCount } from "./Agents.model.ts";
import "./agents.css";

export function SkillPicker({
  available,
  chosen,
  busy,
  onToggle,
}: {
  // null when the list did not load
  available: SkillSummary[] | null;
  chosen: string[];
  busy: boolean;
  onToggle: (id: string) => void;
}) {
  const full = chosen.length >= MAX_SKILLS_PER_AGENT;
  return (
    <div class="field agents-field-wide">
      <RowsListHead
        label="Skills"
        hint={
          available !== null && available.length > 0
            ? skillsCount(chosen.length, MAX_SKILLS_PER_AGENT)
            : undefined
        }
      />
      {available === null ? (
        <span class="hint">The skills did not load. Reload the page.</span>
      ) : available.length === 0 ? (
        <span class="hint">
          No skills yet. <a href="/admin/skills">Add one</a> and it shows here.
        </span>
      ) : (
        <RowsList>
          {available.map((skill) => {
            const on = chosen.includes(skill.id);
            const off = !on && full;
            return (
              <RowsLine key={skill.id} as="label" flush off={off}>
                <RowsCheck
                  name="skills"
                  value={skill.id}
                  checked={on}
                  disabled={busy || off}
                  onChange={() => onToggle(skill.id)}
                />
                <RowsTitle
                  name={skill.name}
                  sub={firstSentence(skill.description)}
                  mono
                />
              </RowsLine>
            );
          })}
        </RowsList>
      )}
    </div>
  );
}
