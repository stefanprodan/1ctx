// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A skill's General tab: what its SKILL.md says about itself and where
// it came from, with Refresh, which fetches the URL again; then the
// agents that carry it, each opening its Skills tab, and Delete, which
// waits until none does, since the server refuses a skill an agent
// carries.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import type { SkillSummary } from "../../../shared/contracts/skill.ts";
import { address, navigate } from "../../app/router.ts";
import { agents } from "../../data/agents.ts";
import { deleteSkill, loadSkills, refreshSkill } from "../../data/skills.ts";
import { AvatarIcon } from "../../lib/avatars.tsx";
import { ago, pluralCommas } from "../../lib/format.ts";
import { configAgentHref } from "../../lib/hrefs.ts";
import { useAction, useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import { RowsAvatar, RowsGo, RowsTitle } from "../../ui/Rows.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { changeLine, metadataLines, sourceLine } from "./Skills.model.ts";

export function SkillGeneral({
  skill,
  now,
}: {
  skill: SkillSummary;
  now: number;
}) {
  return (
    <>
      <About skill={skill} now={now} />
      <UsedBy skill={skill} />
      <DeleteCard skill={skill} />
    </>
  );
}

function Fact({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ComponentChildren;
}) {
  return (
    <>
      <span class="label">{label}</span>
      <span class={`skill-page-fact${mono ? " skill-page-fact-mono" : ""}`}>
        {children}
      </span>
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
                // the server records a failed refresh on the row: the
                // list learns it, so the page's head says so too
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
      <div class="skill-page-facts">
        <Fact label="Description">{skill.description}</Fact>
        {skill.license !== "" && <Fact label="License">{skill.license}</Fact>}
        {skill.compatibility !== "" && (
          <Fact label="Compatibility">{skill.compatibility}</Fact>
        )}
        {metadata.length > 0 && (
          <Fact label="Metadata" mono>
            {metadata.join("\n")}
          </Fact>
        )}
        {skill.allowedTools !== "" && (
          <Fact label="Allowed tools" mono>
            {skill.allowedTools}
          </Fact>
        )}
        <Fact label="Source" mono>
          {`${sourceLine(skill)}\n${skill.sourceUrl}`}
        </Fact>
        <Fact label="Fetched">{ago(skill.fetchedAt, now)}</Fact>
        <Fact label="Digest" mono>
          {`${skill.digest.slice(0, 12)} · ${changeLine(
            skill.lastChange,
            skill.fetchedAt,
            skill.createdAt,
          )}`}
        </Fact>
      </div>
      {refresh.failure.value !== null && (
        <p class="error skill-page-said" role="alert">
          {refresh.failure.value}
        </p>
      )}
    </Setting>
  );
}

function carriers(skill: SkillSummary) {
  return byName(agents.value ?? []).filter((a) => a.skills.includes(skill.id));
}

function UsedBy({ skill }: { skill: SkillSummary }) {
  const users = carriers(skill);
  // Delete's line says no agent carries it
  if (users.length === 0) return null;
  return (
    <Setting list title="Used by" count={String(users.length)}>
      {users.map((a) => (
        <RowsGo key={a.id} href={configAgentHref(a.name, "skills")}>
          <RowsAvatar>
            <AvatarIcon name={a.avatar} size={15} />
          </RowsAvatar>
          <RowsTitle mono name={`@${a.name}`} />
        </RowsGo>
      ))}
    </Setting>
  );
}

// the words over Delete: the agents that keep the skill, or none
export function skillDeleteLine(agentCount: number): string {
  if (agentCount === 0) return "No agent carries it.";
  return `${pluralCommas(agentCount, "agent carries", "agents carry")} it. Remove it from ${
    agentCount === 1 ? "that agent" : "them"
  } first.`;
}

function DeleteCard({ skill }: { skill: SkillSummary }) {
  const asking = useSignal(false);
  const save = useSave(async () => {});
  const used = carriers(skill).length;
  // Escape takes the ask back
  useEffect(() => {
    if (!asking.value) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") asking.value = false;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [asking.value]);
  return (
    <Setting
      danger
      title={`Delete ${skill.name}`}
      line={skillDeleteLine(used)}
      foot={
        <Foot save={save}>
          <div class="skill-page-delete">
            <AskDelete
              save={save}
              asking={asking}
              busy={save.busy || used > 0}
              words={`Delete ${skill.name}?`}
              wordsClass="skill-page-ask"
              // the list drops the skill as the call ends, which takes
              // this card away before act answers: the call leaves
              onDelete={() => {
                void save.act("delete", async () => {
                  const from = address();
                  await deleteSkill(skill.id);
                  if (address() === from) navigate("/config/skills");
                });
              }}
            />
          </div>
        </Foot>
      }
    />
  );
}
