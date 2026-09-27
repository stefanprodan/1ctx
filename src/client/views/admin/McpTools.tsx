// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An MCP server's Tools tab: one card, a draft saved whole. The three
// matcher lists come first, each matcher with the tools it decides, in
// red when it matches none; then the tools by name, each with its side
// and the matcher that set it, narrowed by the search and the side.
// Picked tools move to a side by exact names, and the bar says which
// ones a matcher earlier in the order keeps where they are. A tool
// opens to its description and parameters, the one HTML, rendered on
// the server.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type {
  McpServerSummary,
  McpToolSummary,
} from "../../../shared/contracts/mcp.ts";
import { decide, type Patterns, type ToolSide } from "../../../shared/mcp.ts";
import { patchServer } from "../../data/mcp.ts";
import { firstSentence } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import {
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
import { mcpFieldOf } from "./Mcp.model.ts";
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
}: {
  server: McpServerSummary;
  drafts: McpDrafts;
}) {
  const latest = useRef(server);
  latest.current = server;
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    const p = d.patterns.value;
    d.resetTools(
      await patchServer(latest.current.id, {
        readPatterns: p.read,
        writePatterns: p.write,
        excludedPatterns: p.excluded,
      }),
    );
  }, mcpFieldOf);
  useFocusField(save, form);
  const patterns = d.patterns.value;
  const decided = decide(server.name, server.tools, patterns);
  const counts = sideCounts(decided);
  const shown = shownTools(server.tools, decided, d.q.value, d.filter.value);
  const edit = (next: Patterns, words: string[] = []) => {
    d.patterns.value = next;
    d.moved.value = words;
    save.touch();
  };
  const n = server.tools.length;
  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
      <Setting
        list
        sticky={d.toolsDirty(server)}
        title="Tools"
        count={shown.length === n ? String(n) : `${shown.length} of ${n}`}
        action={
          n > 0 && (
            <Search
              value={d.q.value}
              onChange={(q) => {
                d.q.value = q;
              }}
              placeholder="Search tools"
            />
          )
        }
        foot={
          <DraftFoot
            save={save}
            dirty={d.toolsDirty(server)}
            onDiscard={() => d.resetTools(latest.current)}
          />
        }
      >
        <Matchers
          server={server}
          patterns={patterns}
          busy={save.busy}
          save={save}
          onEdit={(next) => edit(next)}
        />
        {n === 0 ? (
          <RowsNote>The server listed no tools.</RowsNote>
        ) : (
          <>
            <Bar
              drafts={d}
              shown={shown}
              counts={counts}
              busy={save.busy}
              onMove={(target) => {
                const r = moveTools(
                  server.name,
                  server.tools,
                  patterns,
                  d.picked.value,
                  target,
                );
                if ("problem" in r) {
                  d.moved.value = [r.problem];
                  return;
                }
                d.picked.value = [];
                edit(r.patterns, moveWords(r, target));
              }}
            />
            {d.moved.value.length > 0 && (
              <p class="mcp-page-moved" role="status">
                {d.moved.value.join(". ")}.
              </p>
            )}
            {shown.length === 0 && <RowsNote>No tool matches.</RowsNote>}
            <ToolRows drafts={d} tools={shown} decided={decided} />
          </>
        )}
      </Setting>
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
  save: ReturnType<typeof useSave>;
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
  save: ReturnType<typeof useSave>;
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

// the line over the rows: the side filter, or once tools are picked,
// how many and the sides to move them to; the box picks every tool
// shown that can move
function Bar({
  drafts: d,
  shown,
  counts,
  busy,
  onMove,
}: {
  drafts: McpDrafts;
  shown: McpToolSummary[];
  counts: Record<ToolSide, number>;
  busy: boolean;
  onMove: (target: MatcherSide) => void;
}) {
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
          <span class="mcp-page-picked">{`${picked.length} picked`}</span>
          <span class="mcp-page-move-to">Move to</span>
          {MATCHER_SIDES.map(({ side, label }) => (
            <button
              key={side}
              type="button"
              class="btn btn-small"
              disabled={busy}
              onClick={() => onMove(side)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            class="btn-text"
            disabled={busy}
            onClick={() => {
              d.picked.value = [];
            }}
          >
            Clear
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
