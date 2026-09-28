// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SkillCounts } from "../../../shared/api/skills.ts";
import type { SkillSummary } from "../../../shared/contracts/skill.ts";
import type { Params } from "../../app/params.ts";
import { path } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { agents, agentsError } from "../../data/agents.ts";
import { skills, skillsError, skillUsage } from "../../data/skills.ts";
import { count } from "../../lib/format.ts";
import {
  configSkillHref,
  SKILLS_HREF,
  type SkillTab,
} from "../../lib/hrefs.ts";
import { useNow } from "../../lib/now.ts";
import { Page, PageSwitcher } from "../../ui/Page.tsx";
import { SettingAlert, SettingStack } from "../../ui/Setting.tsx";
import { AsideLine, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { TopSection, UsageSection } from "./AdminAside.tsx";
import { refreshLine } from "./refresh.ts";
import { SkillFiles } from "./SkillFiles.tsx";
import { SkillGeneral } from "./SkillGeneral.tsx";
import "./skill-page.css";

export const SKILL_STEPS = [
  zoneStep("Config"),
  { label: "Skills", href: SKILLS_HREF },
];

// by index, so a skill named files opens on General
export function skillTabOf(pathname: string): SkillTab {
  return pathname.split("/")[5] === "files" ? "files" : "general";
}

export function SkillPage({ params }: { params: Params }) {
  const list = skills.value;
  const skill = list?.find((s) => s.name === params.name) ?? null;
  // Used by and Delete need the agents
  const error = skillsError.value ?? agentsError.value;
  const tab = skillTabOf(path.value);
  return (
    <Page
      steps={SKILL_STEPS}
      title={params.name}
      titleMono
      menu={
        skill !== null ? (
          <PageSwitcher
            label="Skills"
            current={skill.id}
            name={skill.name}
            items={(list ?? []).map((s) => ({
              id: s.id,
              label: s.name,
              href: configSkillHref(s.name, tab),
            }))}
            placeholder="Find a skill"
            none="No skill matches"
          />
        ) : undefined
      }
      split
      loading={(list === null || agents.value === null) && error === null}
      empty={
        list !== null && skill === null ? "No skill by that name." : undefined
      }
      error={error}
    >
      {skill !== null && (
        <Split aside={<Aside skill={skill} />}>
          <Body key={skill.id} skill={skill} tab={tab} />
        </Split>
      )}
    </Page>
  );
}

function Body({ skill, tab }: { skill: SkillSummary; tab: SkillTab }) {
  const now = useNow(60_000);
  return (
    <SettingStack>
      {skill.refreshError !== null && skill.refreshFailedAt !== null && (
        <SettingAlert>
          {refreshLine(skill.refreshError, skill.refreshFailedAt, now)}
        </SettingAlert>
      )}
      <Tabs
        tabs={[
          { label: "General", href: configSkillHref(skill.name) },
          {
            label: "Files",
            href: configSkillHref(skill.name, "files"),
            // SKILL.md is a file too
            count: skill.files.length + 1,
          },
        ]}
        active={configSkillHref(skill.name, tab)}
      />
      {tab === "general" && <SkillGeneral skill={skill} now={now} />}
      {tab === "files" && <SkillFiles skill={skill} />}
    </SettingStack>
  );
}

export function LoadLines({ counts }: { counts: SkillCounts }) {
  return (
    <>
      <AsideLine label="Loads">{count(counts.loads)}</AsideLine>
      <AsideLine label="File reads">{count(counts.reads)}</AsideLine>
      <AsideLine label="Failed">{count(counts.failed)}</AsideLine>
    </>
  );
}

function Aside({ skill }: { skill: SkillSummary }) {
  const usage = skillUsage.valueFor(skill.id);
  return (
    <>
      <UsageSection value={usage}>
        {(u) => <LoadLines counts={u} />}
      </UsageSection>
      <TopSection
        label="Most read"
        rows={(usage?.files ?? []).map((f) => ({
          name: f.path,
          value: f.reads,
        }))}
      />
    </>
  );
}
