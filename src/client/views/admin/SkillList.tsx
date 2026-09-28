// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SkillSummary } from "../../../shared/contracts/skill.ts";
import { query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { agents, agentsError } from "../../data/agents.ts";
import { allSkillUsage, skills, skillsError } from "../../data/skills.ts";
import { ago, firstSentence, plural, pluralCommas } from "../../lib/format.ts";
import { configSkillHref } from "../../lib/hrefs.ts";
import { useNow } from "../../lib/now.ts";
import { useListSearch } from "../../lib/search.ts";
import { Page, PageNew } from "../../ui/Page.tsx";
import {
  Rows,
  RowsCard,
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { Split } from "../../ui/Split.tsx";
import { TopSection, UsageSection } from "./AdminAside.tsx";
import { NewSkill } from "./NewSkill.tsx";
import { LoadLines } from "./SkillPage.tsx";
import { carriersOf } from "./Skills.model.ts";

export function SkillList() {
  if (new URLSearchParams(query.value).has("new")) return <NewSkill />;
  return <List />;
}

function List() {
  const rows = skills.value;
  const now = useNow(60_000);
  const all = rows ?? [];
  const { q, shown, count } = useListSearch(all, (s) => [
    s.name,
    s.description,
  ]);
  const error = skillsError.value ?? agentsError.value;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Skills"
      split
      actions={<PageNew href="/admin/config/skills?new" label="Add skill" />}
      loading={(rows === null || agents.value === null) && error === null}
      error={error}
    >
      <Split aside={<Aside list={all} />}>
        <Rows>
          <RowsCard
            label="Skills"
            search={<Search query={q} placeholder="Search skills" />}
            count={count}
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
  const users = carriersOf(agents.value ?? [], skill.id).length;
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
      {/* SKILL.md is a file too */}
      <RowsMeta keep under={plural(skill.files.length + 1, "file")}>
        {users === 0 ? "No agents" : pluralCommas(users, "agent", "agents")}
      </RowsMeta>
    </RowsGo>
  );
}

function Aside({ list }: { list: SkillSummary[] }) {
  const usage = allSkillUsage.value();
  const live = new Set(list.map((s) => s.name));
  return (
    <>
      <UsageSection value={usage}>
        {(u) => <LoadLines counts={u} />}
      </UsageSection>
      <TopSection
        label="Most loaded"
        rows={(usage?.skills ?? [])
          .filter((s) => s.loads > 0)
          .map((s) => ({
            name: s.name,
            value: s.loads,
            href: live.has(s.name) ? configSkillHref(s.name) : undefined,
          }))}
      />
    </>
  );
}
