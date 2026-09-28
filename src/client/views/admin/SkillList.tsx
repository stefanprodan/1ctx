// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Config › Skills: a list of links, one row per skill in name order,
// the name over its first sentence, or over the failed refresh in red;
// at the right the agents that carry it over its files. The card's head
// searches and counts, Add skill is in the page's head. The aside has
// every skill's loads and file reads over the last 30 days. `?new` is
// Add skill.

import { useSignal } from "@preact/signals";
import type { SkillSummary } from "../../../shared/contracts/skill.ts";
import { query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { agents, agentsError } from "../../data/agents.ts";
import { allSkillUsage, skills, skillsError } from "../../data/skills.ts";
import {
  ago,
  count,
  firstSentence,
  plural,
  pluralCommas,
} from "../../lib/format.ts";
import { configSkillHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { matches } from "../../lib/search.ts";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsCard,
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { NewSkill } from "./NewSkill.tsx";
import "./skill-page.css";

export function SkillList() {
  if (new URLSearchParams(query.value).has("new")) return <NewSkill />;
  return <List />;
}

function List() {
  const rows = skills.value;
  const q = useSignal("");
  const now = useNow(60_000);
  // the data layer keeps the list in name order
  const all = rows ?? [];
  const shown = all.filter((s) => matches(q.value, [s.name, s.description]));
  const error = skillsError.value ?? agentsError.value;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Skills"
      split
      actions={
        <a class="btn btn-small" href="/admin/config/skills?new">
          <Icon name="plus" size={14} />
          Add skill
        </a>
      }
      loading={(rows === null || agents.value === null) && error === null}
      error={error}
    >
      <Split aside={<Aside list={all} />}>
        <Rows>
          <RowsCard
            label="Skills"
            search={
              <Search
                value={q.value}
                onChange={(next) => {
                  q.value = next;
                }}
                placeholder="Search skills"
              />
            }
            count={
              all.length === 0
                ? undefined
                : shown.length !== all.length
                  ? `${shown.length} of ${all.length}`
                  : String(all.length)
            }
          >
            {all.length === 0 && (
              <RowsNote>
                No skills yet. Add skill takes a URL and keeps what it finds
                there.
              </RowsNote>
            )}
            {all.length > 0 && shown.length === 0 && (
              <RowsNote>No skill matches.</RowsNote>
            )}
            {shown.map((s) => (
              <Row key={s.id} skill={s} now={now} />
            ))}
          </RowsCard>
        </Rows>
      </Split>
    </Page>
  );
}

function Row({ skill, now }: { skill: SkillSummary; now: number }) {
  const failed = skill.refreshFailedAt !== null && skill.refreshError !== null;
  // counted as the skill's page counts them, from the agents list
  const users = (agents.value ?? []).filter((a) =>
    a.skills.includes(skill.id),
  ).length;
  return (
    <RowsGo href={configSkillHref(skill.name)}>
      <RowsTitle
        mono
        name={skill.name}
        sub={
          failed
            ? `refresh failed ${ago(skill.refreshFailedAt!, now)}`
            : firstSentence(skill.description)
        }
        bad={failed}
      />
      <RowsMeta keep>
        <span class="skill-page-list-meta">
          <span>
            {users === 0 ? "No agents" : pluralCommas(users, "agent", "agents")}
          </span>
          <span class="skill-page-list-files">
            {/* SKILL.md is a file too */}
            {plural(skill.files.length + 1, "file")}
          </span>
        </span>
      </RowsMeta>
    </RowsGo>
  );
}

// the most loaded skills the aside names
const TOP_SKILLS = 5;

function Aside({ list }: { list: SkillSummary[] }) {
  const known = allSkillUsage.value;
  const usage = known?.usage ?? null;
  const top = usage?.skills.filter((s) => s.loads > 0).slice(0, TOP_SKILLS);
  const live = new Set(list.map((s) => s.name));
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
      {top !== undefined && top.length > 0 && (
        <AsideSection label="Most loaded">
          {top.map((s) => (
            <AsideLine
              key={s.name}
              label={s.name}
              cut
              href={live.has(s.name) ? configSkillHref(s.name) : undefined}
            >
              {count(s.loads)}
            </AsideLine>
          ))}
        </AsideSection>
      )}
    </>
  );
}
