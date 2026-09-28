// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { MAX_SKILLS_PER_AGENT } from "../../../shared/words.ts";
import { updateAgent } from "../../data/agents.ts";
import { skills as skillRows } from "../../data/skills.ts";
import { ago, firstSentence } from "../../lib/format.ts";
import { toggledId } from "../../lib/ids.ts";
import { useNow } from "../../lib/now.ts";
import { useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { Finder } from "../../ui/Finder.tsx";
import {
  RowsEnd,
  RowsLine,
  RowsNote,
  RowsRemove,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Setting, SettingForm } from "../../ui/Setting.tsx";
import { cardBody } from "./AgentPage.model.ts";
import { type AgentDrafts, loadedRows } from "./AgentPage.state.ts";
import { listed, skillsCount } from "./Agents.model.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLatest } from "./drafts.ts";

export function AgentSkills({
  agent,
  drafts: d,
}: {
  agent: AgentSummary;
  drafts: AgentDrafts;
}) {
  const latest = useLatest(agent);
  const all = skillRows.value;
  const now = useNow(60_000);
  const chosen = () => listed(d.skills.value, (id) => id, skillRows.value);
  const save = useSave(() =>
    d.save(async () => {
      const saved = await updateAgent(
        latest.current.id,
        cardBody(latest.current, { skills: chosen() }, loadedRows()),
      );
      d.resetSkills(saved);
    }),
  );
  const picked = chosen();
  const rows = byName((all ?? []).filter((s) => picked.includes(s.id)));
  const atCap = picked.length >= MAX_SKILLS_PER_AGENT;
  const takesTools = agent.model.tools;
  const listable = takesTools && all !== null && all.length > 0;
  const toggle = (id: string) => {
    d.skills.value = toggledId(picked, id);
    save.touch();
  };
  return (
    <SettingForm save={save}>
      <Setting
        list
        title="Skills"
        count={
          listable
            ? skillsCount(picked.length, MAX_SKILLS_PER_AGENT)
            : undefined
        }
        action={
          listable && (
            <Finder
              label="Skills"
              add="Add skill"
              title={
                atCap ? `At the cap of ${MAX_SKILLS_PER_AGENT}` : undefined
              }
              disabled={atCap || save.busy}
              options={byName(all.filter((s) => !picked.includes(s.id))).map(
                (s) => ({
                  value: s.id,
                  label: s.name,
                  sub: firstSentence(s.description),
                }),
              )}
              mono
              wide
              placeholder="Find a skill"
              none="No skill matches"
              empty="Every skill is added"
              onPick={toggle}
            />
          )
        }
        foot={
          listable ? (
            <DraftFoot
              locked={d.saving.value}
              save={save}
              dirty={d.skillsDirty(agent)}
              onDiscard={() => d.resetSkills(latest.current)}
            />
          ) : undefined
        }
      >
        {all === null ? (
          <RowsNote>The skills did not load. Reload the page.</RowsNote>
        ) : all.length === 0 ? (
          <RowsNote>
            No skills yet. <a href="/admin/config/skills?new">Add one</a> and it
            shows here.
          </RowsNote>
        ) : !takesTools ? (
          <RowsNote>This model takes no tools.</RowsNote>
        ) : rows.length === 0 ? (
          <RowsNote>No skills.</RowsNote>
        ) : (
          rows.map((s) => (
            <RowsLine key={s.id} flush>
              <RowsTitle
                name={s.name}
                sub={
                  s.refreshFailedAt === null
                    ? firstSentence(s.description)
                    : `refresh failed ${ago(s.refreshFailedAt, now)}`
                }
                bad={s.refreshFailedAt !== null}
                mono
              />
              <RowsEnd>
                <RowsRemove
                  name={s.name}
                  disabled={save.busy}
                  onRemove={() => toggle(s.id)}
                />
              </RowsEnd>
            </RowsLine>
          ))
        )}
      </Setting>
    </SettingForm>
  );
}
