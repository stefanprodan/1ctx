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
import { Icon } from "../../lib/icons.tsx";
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
      <span class="agents-skills-head">
        <span class="label">Skills</span>
        {available !== null && available.length > 0 && (
          <span class="agents-skills-count">
            {skillsCount(chosen.length, MAX_SKILLS_PER_AGENT)}
          </span>
        )}
      </span>
      {available === null ? (
        <span class="hint">The skills did not load. Reload the page.</span>
      ) : available.length === 0 ? (
        <span class="hint">
          No skills yet. <a href="/admin/skills">Add one</a> and it shows here.
        </span>
      ) : (
        <div class="agents-skills">
          {available.map((skill) => {
            const on = chosen.includes(skill.id);
            return (
              <label
                key={skill.id}
                class={`agents-skill${on ? " agents-skill-on" : ""}${
                  !on && full ? " agents-skill-full" : ""
                }`}
              >
                <input
                  type="checkbox"
                  class="agents-skill-input"
                  name="skills"
                  value={skill.id}
                  checked={on}
                  disabled={busy || (!on && full)}
                  onChange={() => onToggle(skill.id)}
                />
                <span class="agents-skill-box" aria-hidden="true">
                  {on && <Icon name="check" size={12} />}
                </span>
                <span class="agents-skill-title">
                  <span class="agents-skill-name">{skill.name}</span>
                  <span class="agents-skill-desc">
                    {firstSentence(skill.description)}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
