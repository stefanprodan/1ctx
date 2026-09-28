// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SkillSummary } from "../../../shared/contracts/skill.ts";
import { AgentLinks } from "../../agents/AgentLinks.tsx";
import { agents } from "../../data/agents.ts";
import { deleteSkill, loadSkills, refreshSkill } from "../../data/skills.ts";
import { ago } from "../../lib/format.ts";
import { configAgentHref } from "../../lib/hrefs.ts";
import { useAction } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import {
  Setting,
  SettingDelete,
  SettingFact,
  SettingFacts,
} from "../../ui/Setting.tsx";
import {
  carriersOf,
  changeLine,
  metadataLines,
  skillDeleteLine,
  sourceLine,
} from "./Skills.model.ts";

export function SkillGeneral({
  skill,
  now,
}: {
  skill: SkillSummary;
  now: number;
}) {
  const carriers = byName(carriersOf(agents.value ?? [], skill.id));
  return (
    <>
      <About skill={skill} now={now} />
      {/* Delete's line says no agent carries it */}
      {carriers.length > 0 && (
        <Setting list title="Used by" count={String(carriers.length)}>
          <AgentLinks
            agents={carriers}
            href={(a) => configAgentHref(a.name, "skills")}
          />
        </Setting>
      )}
      <SettingDelete
        title={`Delete ${skill.name}`}
        line={skillDeleteLine(carriers.length)}
        ask={`Delete ${skill.name}?`}
        off={carriers.length > 0}
        onDelete={() => deleteSkill(skill.id)}
        leaveTo="/admin/config/skills"
      />
    </>
  );
}

function About({ skill, now }: { skill: SkillSummary; now: number }) {
  const refresh = useAction();
  const metadata = metadataLines(skill.metadata);
  return (
    <Setting
      title="About"
      action={
        <button
          type="button"
          class="btn btn-small"
          disabled={refresh.busy.value}
          onClick={() =>
            void refresh.run(async () => {
              try {
                await refreshSkill(skill.id);
              } catch (err) {
                // the server records a failed refresh on the row, so the
                // list reloads to show it
                await loadSkills();
                throw err;
              }
            })
          }
        >
          {refresh.busy.value ? "Refreshing" : "Refresh"}
        </button>
      }
    >
      <SettingFacts>
        <SettingFact label="Description" pre>
          {skill.description}
        </SettingFact>
        {skill.license !== "" && (
          <SettingFact label="License" pre>
            {skill.license}
          </SettingFact>
        )}
        {skill.compatibility !== "" && (
          <SettingFact label="Compatibility" pre>
            {skill.compatibility}
          </SettingFact>
        )}
        {metadata.length > 0 && (
          <SettingFact label="Metadata" mono pre>
            {metadata.join("\n")}
          </SettingFact>
        )}
        {skill.allowedTools !== "" && (
          <SettingFact label="Allowed tools" mono pre>
            {skill.allowedTools}
          </SettingFact>
        )}
        <SettingFact label="Source" mono pre>
          {`${sourceLine(skill)}\n${skill.sourceUrl}`}
        </SettingFact>
        <SettingFact label="Fetched">{ago(skill.fetchedAt, now)}</SettingFact>
        <SettingFact label="Digest" mono>
          {`${skill.digest.slice(0, 12)} · ${changeLine(
            skill.lastChange,
            skill.fetchedAt,
            skill.createdAt,
          )}`}
        </SettingFact>
      </SettingFacts>
      {/* a recorded failure is already the page's alert */}
      {refresh.failure.value !== null && skill.refreshError === null && (
        <p class="error skill-page-said" role="alert">
          {refresh.failure.value}
        </p>
      )}
    </Setting>
  );
}
