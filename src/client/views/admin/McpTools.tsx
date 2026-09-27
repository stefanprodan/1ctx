// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An MCP server's Tools tab, a draft saved whole from the page's head,
// which stays on screen: the three matcher lists, each matcher with the
// tools it decides, in red when it matches none; then the tools by
// name, each with its side and the matcher that set it, narrowed by the
// search in the list's head and the side.
// Picked tools move to a side by exact names, and the bar says which
// ones a matcher earlier in the order keeps where they are. A tool
// opens to its description and parameters, the one HTML, rendered on
// the server.

import { useSignal } from "@preact/signals";
import type {
  McpServerSummary,
  McpToolSummary,
} from "../../../shared/contracts/mcp.ts";
import { decide, type Patterns, type ToolSide } from "../../../shared/mcp.ts";
import { firstSentence } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import {
  RowsCard,
  RowsCheck,
  RowsMeta,
  RowsNote,
  RowsOpen,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { DraftFoot } from "./DraftFoot.tsx";
import type { McpDrafts } from "./McpPage.state.ts";
import {
  addMatcher,
  decidedWords,
  MATCHER_SIDES,
  type Matcher,
  type MatcherSide,
  matchers,
  moveTools,
  moveWords,
  removeMatcher,
  SIDE_WORDS,
  type SideFilter,
  shownTools,
  sideCounts,
} from "./McpTools.model.ts";

const FIELD: Record<MatcherSide, string> = {
  read: "readPatterns",
  write: "writePatterns",
  excluded: "excludedPatterns",
};

const SIDE_HINT: Record<MatcherSide, string> = {
  read: "A tool name, or a prefix ending in *",
  write: "Empty takes every tool not read or excluded",
  excluded: "Never offered to any agent, first in the order",
};

export function McpTools({
  server,
  drafts: d,
  save,
}: {
  server: McpServerSummary;
  drafts: McpDrafts;
  // the page's, so a tab switch keeps its state
  save: Save;
}) {
  const patterns = d.patterns.value;
  const decided = decide(server.name, server.tools, patterns);
  const counts = sideCounts(decided);
  const shown = shownTools(server.tools, decided, d.q.value, d.filter.value);
  const edit = (next: Patterns) => {
    d.patterns.value = next;
    d.moved.value = [];
    save.touch();
  };
  const n = server.tools.length;
  // the same foot under the matchers and under the list, so Save is near
  // wherever the edit was made
  const foot = (
    <DraftFoot
      save={save}
      dirty={d.toolsDirty(server)}
      hint={
        d.moved.value.length > 0 ? `${d.moved.value.join(". ")}.` : undefined
      }
      onDiscard={() => d.resetTools(server)}
    />
  );
  return (
    <form
      class="mcp-page-tools"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
      <Setting title="Matchers" foot={foot}>
        <Matchers
          server={server}
          patterns={patterns}
          busy={save.busy}
          save={save}
          onEdit={(next) => edit(next)}
        />
      </Setting>
      <RowsCard
        label="Tools"
        search={
          <Search
            value={d.q.value}
            onChange={(q) => {
              d.q.value = q;
            }}
            placeholder="Search tools"
          />
        }
        count={shown.length === n ? String(n) : `${shown.length} of ${n}`}
        wrap
      >
        {n === 0 ? (
          <RowsNote>The server listed no tools.</RowsNote>
        ) : (
          <>
            <Bar
              server={server}
              drafts={d}
              shown={shown}
              counts={counts}
              save={save}
            />
            {shown.length === 0 && <RowsNote>No tool matches.</RowsNote>}
            <ToolRows drafts={d} tools={shown} decided={decided} />
          </>
        )}
        <div class="mcp-page-foot">{foot}</div>
      </RowsCard>
    </form>
  );
}

function Matchers({
  server,
  patterns,
  busy,
  save,
  onEdit,
}: {
  server: McpServerSummary;
  patterns: Patterns;
  busy: boolean;
  save: Save;
  onEdit: (next: Patterns) => void;
}) {
  const all = matchers(server.name, server.tools, patterns);
  return (
    <div class="mcp-page-matchers">
      {MATCHER_SIDES.map(({ side, label }) => (
        <MatcherLine
          key={side}
          side={side}
          label={label}
          list={all[side]}
          patterns={patterns}
          busy={busy}
          save={save}
          onEdit={onEdit}
        />
      ))}
    </div>
  );
}

function MatcherLine({
  side,
  label,
  list,
  patterns,
  busy,
  save,
  onEdit,
}: {
  side: MatcherSide;
  label: string;
  list: Matcher[];
  patterns: Patterns;
  busy: boolean;
  save: Save;
  onEdit: (next: Patterns) => void;
}) {
  const text = useSignal("");
  const problem = useSignal<string | null>(null);
  const field = FIELD[side];
  const add = () => {
    const r = addMatcher(patterns, side, text.value);
    if ("problem" in r) {
      problem.value = r.problem;
      return;
    }
    text.value = "";
    problem.value = null;
    onEdit(r.patterns);
  };
  const refused = save.fieldError(field) !== null;
  return (
    <div class="mcp-page-matcher">
      <span class="label mcp-page-matcher-label">{label}</span>
      <div class="field mcp-page-matcher-body">
        <div class="mcp-page-chips">
          {list.map((m) => (
            <span
              key={m.pattern}
              class={`tag mcp-page-chip${m.matches ? "" : " mcp-page-chip-none"}`}
              title={
                m.matches
                  ? `${m.pattern} decides ${m.decides} ${m.decides === 1 ? "tool" : "tools"}`
                  : `${m.pattern} matches no tool`
              }
            >
              <span class="mcp-page-chip-name">{m.pattern}</span>
              <span class="mcp-page-chip-count">{m.decides}</span>
              <button
                type="button"
                class="btn-icon mcp-page-chip-remove"
                aria-label={`Remove ${m.pattern} from ${label}`}
                disabled={busy}
                onClick={() => {
                  problem.value = null;
                  onEdit(removeMatcher(patterns, side, m.pattern));
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
          <input
            name={field}
            class="mcp-page-add"
            autocomplete="off"
            spellcheck={false}
            placeholder={list.length === 0 ? "Add a matcher" : "Add"}
            aria-label={`Add a matcher to ${label}`}
            aria-invalid={problem.value !== null || refused || undefined}
            disabled={busy}
            value={text.value}
            onInput={(e) => {
              text.value = (e.currentTarget as HTMLInputElement).value;
              problem.value = null;
            }}
            onKeyDown={(e) => {
              // Enter adds the matcher, never submits the card
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            onBlur={() => {
              if (text.value.trim() !== "") add();
            }}
          />
        </div>
        {problem.value !== null ? (
          <span class="hint error">{problem.value}</span>
        ) : refused ? (
          <FieldError save={save} field={field} />
        ) : (
          <span class="hint">{SIDE_HINT[side]}</span>
        )}
      </div>
    </div>
  );
}

// the line over the rows: the side filter, or while tools are picked
// how many and the sides to move them to, in the same line so the rows
// never move; the box at the end picks every tool shown that can move
function Bar({
  server,
  drafts: d,
  shown,
  counts,
  save,
}: {
  server: McpServerSummary;
  drafts: McpDrafts;
  shown: McpToolSummary[];
  counts: Record<ToolSide, number>;
  save: Save;
}) {
  const busy = save.busy;
  const movable = shown.filter(
    (t) => t.unusable === null && t.wireName !== null,
  );
  const picked = d.picked.value;
  const all =
    movable.length > 0 && movable.every((t) => picked.includes(t.name));
  const filters: { value: SideFilter; label: string }[] = [
    {
      value: "all",
      label: `All ${counts.read + counts.write + counts.excluded + counts.unusable}`,
    },
    { value: "read", label: `Read ${counts.read}` },
    { value: "write", label: `Write ${counts.write}` },
    { value: "excluded", label: `Excluded ${counts.excluded}` },
  ];
  if (counts.unusable > 0 || d.filter.value === "unusable") {
    filters.push({ value: "unusable", label: `Unusable ${counts.unusable}` });
  }
  return (
    <div class="mcp-page-bar">
      {picked.length === 0 ? (
        <Seg
          label="Side"
          small
          options={filters}
          value={d.filter.value}
          onPick={(value) => {
            d.filter.value = value;
          }}
        />
      ) : (
        <div class="mcp-page-move">
          <span class="mcp-page-move-words">
            {`${picked.length} picked`}
            <span class="mcp-page-move-to">. Move to</span>
          </span>
          {MATCHER_SIDES.map(({ side, label }) => (
            <button
              key={side}
              type="button"
              class="btn btn-small"
              disabled={busy}
              onClick={() => movePicked(server, d, side, save)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            class="btn-icon mcp-page-clear"
            aria-label="Clear the picks"
            title="Clear the picks"
            disabled={busy}
            onClick={() => {
              d.picked.value = [];
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      <span class="mcp-page-all">
        <RowsCheck
          name="pickAll"
          label="Pick every tool shown"
          checked={all}
          disabled={busy || movable.length === 0}
          onChange={() => {
            const names = new Set(movable.map((t) => t.name));
            d.picked.value = all
              ? picked.filter((n) => !names.has(n))
              : [...new Set([...picked, ...names])];
          }}
        />
      </span>
    </div>
  );
}

// the picked tools to a side, the words of what moved kept for the head
export function movePicked(
  server: McpServerSummary,
  d: McpDrafts,
  target: MatcherSide,
  save: Save,
): void {
  const r = moveTools(
    server.name,
    server.tools,
    d.patterns.value,
    d.picked.value,
    target,
  );
  if ("problem" in r) {
    d.moved.value = [r.problem];
    return;
  }
  d.picked.value = [];
  d.patterns.value = r.patterns;
  d.moved.value = moveWords(r, target);
  save.touch();
}

function ToolRows({
  drafts: d,
  tools,
  decided,
}: {
  drafts: McpDrafts;
  tools: McpToolSummary[];
  decided: ReturnType<typeof decide>;
}) {
  const open = useSignal<string | null>(null);
  const picked = d.picked.value;
  return (
    <>
      {tools.map((tool) => {
        const at = decided.get(tool.name)!;
        const unusable = at.side === "unusable";
        const on = picked.includes(tool.name);
        const by = decidedWords(at);
        return (
          <RowsOpen
            key={tool.name}
            open={open.value === tool.name}
            onToggle={() => {
              open.value = open.value === tool.name ? null : tool.name;
            }}
            indent="chevron"
            off={at.side === "excluded" || unusable}
            head={
              <>
                <RowsTitle
                  mono
                  name={tool.name}
                  sub={firstSentence(tool.description) || undefined}
                  subWide
                />
                <RowsMeta bad={unusable}>
                  <span class={`mcp-page-side mcp-page-side-${at.side}`}>
                    {SIDE_WORDS[at.side]}
                  </span>
                  {unusable
                    ? ` · ${tool.unusable ?? "name too long"}`
                    : by !== "" && <span class="mcp-page-by">{` ${by}`}</span>}
                </RowsMeta>
              </>
            }
            end={
              <span class="mcp-page-pick">
                <RowsCheck
                  name="pick"
                  label={`Pick ${tool.name}`}
                  value={tool.name}
                  checked={on}
                  disabled={unusable}
                  onChange={() => {
                    d.picked.value = on
                      ? picked.filter((n) => n !== tool.name)
                      : [...picked, tool.name];
                  }}
                />
              </span>
            }
          >
            <div class="mcp-page-tool">
              {tool.description !== "" && (
                <span class="mcp-page-tool-text">{tool.description}</span>
              )}
              <div
                class="mcp-page-tool-params"
                // rendered on the server from the schema's JSON inside a
                // code fence, as the Tools page shows a built-in's
                dangerouslySetInnerHTML={{ __html: tool.parametersHtml }}
              />
            </div>
          </RowsOpen>
        );
      })}
    </>
  );
}
