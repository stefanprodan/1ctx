// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A skill's page under Config: the crumb is the head, its own step the
// switcher to the other skills; the failed refresh over the tabs when
// there is one; then General and Files. Nothing on it drafts: a skill
// is what its URL held at the last fetch, so the page reads it,
// refreshes it and deletes it. The aside has the skill's last 30 days
// and its most read files.

import type { SkillSummary } from "../../../shared/contracts/skill.ts";
import type { Params } from "../../app/params.ts";
import { path } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { agentsError } from "../../data/agents.ts";
import { skills, skillsError, skillUsage } from "../../data/skills.ts";
import { ago, count, sentence } from "../../lib/format.ts";
import { configSkillHref, type SkillTab } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { Finder } from "../../ui/Finder.tsx";
import { Page } from "../../ui/Page.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { SkillFiles } from "./SkillFiles.tsx";
import { SkillGeneral } from "./SkillGeneral.tsx";
import "./skill-page.css";

const STEPS = [zoneStep("Config"), { label: "Skills", href: "/config/skills" }];

// the step after the name, so a skill named files opens on General
export function skillTabOf(pathname: string): SkillTab {
  return pathname.split("/")[4] === "files" ? "files" : "general";
}

// the most read files the aside names
const TOP_FILES = 5;

export function SkillPage({ params }: { params: Params }) {
  const list = skills.value;
  const skill = list?.find((s) => s.name === params.name) ?? null;
  // Used by names the agents with their avatars, so the page waits for them
  const error = skillsError.value ?? agentsError.value;
  const tab = skillTabOf(path.value);
  return (
    <Page
      steps={STEPS}
      title={params.name}
      titleMono
      menu={skill !== null ? <Switcher skill={skill} tab={tab} /> : undefined}
      split
      loading={list === null && error === null}
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

// the crumb's own step: the other skills, by name, a pick opening its
// page on the same tab
function Switcher({ skill, tab }: { skill: SkillSummary; tab: SkillTab }) {
  // the data layer keeps the list in name order
  const list = skills.value ?? [];
  if (list.length < 2) {
    return <span class="page-crumb-on page-crumb-path">{skill.name}</span>;
  }
  return (
    <Finder
      label="Skills"
      triggerClass="page-pill"
      title={skill.name}
      trigger={
        <>
          <span class="cut">{skill.name}</span>
          <Icon name="chevron" size={14} class="page-pill-chevron" />
        </>
      }
      options={list.map((s) => ({
        value: s.id,
        label: s.name,
        href: configSkillHref(s.name, tab),
      }))}
      value={skill.id}
      mono
      wide
      placeholder="Find a skill"
      none="No skill matches"
    />
  );
}

function Body({ skill, tab }: { skill: SkillSummary; tab: SkillTab }) {
  const now = useNow(60_000);
  const failed = skill.refreshError !== null && skill.refreshFailedAt !== null;
  return (
    <div class="skill-page">
      {failed && (
        <p class="skill-page-bad" role="status">
          <Icon name="alert" size={16} class="skill-page-bad-icon" />
          {`Refresh failed ${ago(skill.refreshFailedAt!, now)}: ${sentence(
            skill.refreshError!,
          )} Agents still get the copy fetched ${ago(skill.fetchedAt, now)}.`}
        </p>
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
    </div>
  );
}

function Aside({ skill }: { skill: SkillSummary }) {
  const known =
    skillUsage.value?.skillId === skill.id ? skillUsage.value : null;
  const usage = known?.usage ?? null;
  const top = usage?.files.slice(0, TOP_FILES) ?? [];
  return (
    <>
      <AsideSection label="Last 30 days">
        {known === null ? (
          <p class="split-empty">Loading</p>
        ) : usage === null ? (
          <p class="split-empty">Did not load.</p>
        ) : (
          <>
            <AsideLine label="Loads">{count(usage.loads)}</AsideLine>
            <AsideLine label="File reads">{count(usage.reads)}</AsideLine>
            <AsideLine label="Failed">{count(usage.failed)}</AsideLine>
          </>
        )}
      </AsideSection>
      {top.length > 0 && (
        <AsideSection label="Most read">
          {top.map((f) => (
            <AsideLine key={f.path} label={f.path} cut>
              {count(f.reads)}
            </AsideLine>
          ))}
        </AsideSection>
      )}
    </>
  );
}
