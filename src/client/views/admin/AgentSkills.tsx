// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's Skills tab: one card of the skills it carries, each its
// name over its first sentence and a remove, and Add over the skills it
// does not carry yet, off at the cap. A draft with Discard and Save,
// never a write on the click. A model that takes no tools says so in
// place of the list: a turn offers skills through a tool, so it gets
// none.

import { useRef } from "preact/hooks";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { MAX_SKILLS_PER_AGENT } from "../../../shared/words.ts";
import { updateAgent } from "../../data/agents.ts";
import { skills as skillRows } from "../../data/skills.ts";
import { ago, firstSentence } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { toggledId } from "../../lib/ids.ts";
import { useNow } from "../../lib/now.ts";
import { useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { Finder } from "../../ui/Finder.tsx";
import { RowsEnd, RowsLine, RowsNote, RowsTitle } from "../../ui/Rows.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { cardBody, cardFieldOf } from "./AgentPage.model.ts";
import { type AgentDrafts, loadedRows } from "./AgentPage.state.ts";
import { listed, skillsCount } from "./Agents.model.ts";
import { DraftFoot } from "./DraftFoot.tsx";

export function AgentSkills({
  agent,
  drafts: d,
}: {
  agent: AgentSummary;
  drafts: AgentDrafts;
}) {
  const latest = useRef(agent);
  latest.current = agent;
  const all = skillRows.value;
  const now = useNow(60_000);
  // a skill deleted since the save drops from it
  const chosen = () => listed(d.skills.value, (id) => id, skillRows.value);
  const save = useSave(
    () =>
      d.save(async () => {
        const saved = await updateAgent(
          latest.current.id,
          cardBody(latest.current, { skills: chosen() }, loadedRows()),
        );
        d.resetSkills(saved);
      }),
    cardFieldOf([]),
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
  // Save is the foot's submit
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
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
              trigger={
                <>
                  <Icon name="plus" size={14} />
                  Add skill
                </>
              }
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
              align="right"
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
            No skills yet. <a href="/config/skills">Add one</a> and it shows
            here.
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
                <button
                  type="button"
                  class="btn-icon agent-page-remove"
                  aria-label={`Remove ${s.name}`}
                  title="Remove"
                  disabled={save.busy}
                  onClick={() => toggle(s.id)}
                >
                  <Icon name="close" size={14} />
                </button>
              </RowsEnd>
            </RowsLine>
          ))
        )}
      </Setting>
    </form>
  );
}
