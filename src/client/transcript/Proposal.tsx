// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A change to a scheduled task the agent proposed, one line under the
// fold: what it does to which task, when it runs or what changes, and
// Confirm or Dismiss while it waits. The task page has the rest.

import { useSignal } from "@preact/signals";
import type { RefObject } from "preact";
import { useEffect, useMemo } from "preact/hooks";
import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import type {
  AutomationDraft,
  ProposalFields,
} from "../../shared/contracts/automation-draft.ts";
import {
  decideDraft,
  draftTask,
  loadDraftTask,
  taskFailing,
} from "../data/session-drafts.ts";
import { ago } from "../lib/format.ts";
import { automationHref, runHref, userHref } from "../lib/hrefs.ts";
import { Icon } from "../lib/icons.tsx";
import { useNow } from "../lib/now.ts";
import { useCut } from "../lib/resize.ts";
import { useAction } from "../lib/save.ts";
import { Fold } from "../ui/Fold.tsx";
import {
  agoTickMs,
  changedFields,
  changedLines,
  createTexts,
  GONE_NAME,
  HEADS,
  INERT_WORDS,
  lineDetail,
  lineHead,
  nameTarget,
  opens,
  type ProposalLine,
  type TextBlock,
  UNREAD_NAME,
  updateTexts,
  visibleParts,
} from "./Proposal.model.ts";
import "./proposal.css";

function Text({ text }: { text: string }) {
  return (
    <>
      {visibleParts(text).map((part, i) =>
        part.mark ? (
          <span key={i} class="proposal-mark" title="Invisible character">
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

// a new task's instructions and guidance; an update's changed fields
// with their old values, then each text's changed lines, or the whole
// text once nothing differs
export function Details({
  draft,
  before,
}: {
  draft: AutomationDraft;
  before: AutomationSummary | null;
}) {
  if (draft.action === "create") {
    return (
      <div class="proposal-details">
        {createTexts(draft.fields).map((block) => (
          <TextBox key={block.label ?? ""} block={block} />
        ))}
        {!draft.fields.ownMemory && <p class="proposal-note">No memory</p>}
      </div>
    );
  }
  return draft.action === "update" ? (
    <UpdateDetails fields={draft.fields} before={before} />
  ) : null;
}

// the lines a box shows before Show all, the same count as proposal.css
export const CUT_LINES = 18;

function TextBox({ block }: { block: TextBlock }) {
  const { el, open, long } = useCut<HTMLDivElement>([block.was, block.value]);
  return (
    <TextFold
      block={block}
      el={el}
      open={open.value}
      long={long.value}
      onOpen={() => {
        open.value = true;
      }}
    />
  );
}

// a text, or its changed lines, cut to a few lines with Show all in the
// fade, never a scroll box of its own; a count of lines cuts it before
// the measure, which also catches long lines that wrap
export function TextFold({
  block,
  el,
  open,
  long,
  onOpen,
}: {
  block: TextBlock;
  el?: RefObject<HTMLDivElement | null>;
  open: boolean;
  long: boolean;
  onOpen: () => void;
}) {
  const { was, value } = block;
  const changed = useMemo(
    () => (was === undefined ? [] : changedLines(was, value)),
    [was, value],
  );
  // pre-wrap draws no line for a trailing newline
  const lines =
    changed.length > 0
      ? changed.length
      : value.replace(/\n$/, "").split("\n").length;
  const cut = long || lines > CUT_LINES;
  return (
    <div class="proposal-block">
      {block.label !== null && (
        <span class="proposal-label">{block.label}</span>
      )}
      {/* a cleared guidance with nothing to strike draws no empty box */}
      {changed.length === 0 && value === "" ? (
        <p class="proposal-note">None</p>
      ) : (
        <div class="proposal-text">
          <Fold cut={cut && !open} onOpen={onOpen} label="Show all">
            <div
              ref={el}
              class={`proposal-body${open ? "" : " proposal-clip"}`}
            >
              {changed.length === 0 ? (
                <Text text={value} />
              ) : (
                changed.map((line, i) => (
                  <div key={i} class={`proposal-diff proposal-${line.kind}`}>
                    <Text text={line.text === "" ? " " : line.text} />
                  </div>
                ))
              )}
            </div>
          </Fold>
        </div>
      )}
    </div>
  );
}

function UpdateDetails({
  fields: f,
  before,
}: {
  fields: Partial<ProposalFields>;
  before: AutomationSummary | null;
}) {
  return (
    <div class="proposal-details">
      {changedFields(f, before).map((row) => (
        <div key={row.label} class="proposal-field">
          <span class="proposal-label">{row.label}</span>
          {row.was !== null && <span class="proposal-was">{row.was}</span>}
          <span class="proposal-value">{row.value}</span>
        </div>
      ))}
      {updateTexts(f, before).map((block) => (
        <TextBox key={block.label ?? ""} block={block} />
      ))}
    </div>
  );
}

function Inert({ line }: { line: Extract<ProposalLine, { kind: "inert" }> }) {
  const head = HEADS[line.action];
  const taskId = line.taskId;
  useEffect(() => {
    if (taskId !== null) void loadDraftTask(taskId);
  });
  const task = taskId === null ? null : draftTask(taskId);
  return (
    <div class="proposal">
      <div class="proposal-row">
        <span class="proposal-line">
          <span class="proposal-lead">
            <span class="proposal-toggle" />
            <Icon name={head.icon} size={12} class="proposal-icon" />
          </span>
          <span class="proposal-main">
            <span class="proposal-kind">{head.title}</span>
            {line.name !== null && (
              <span class="proposal-name">{line.name}</span>
            )}
            {taskId !== null && task && (
              <a class="proposal-name" href={automationHref(taskId)}>
                {task.name}
              </a>
            )}
            {taskId !== null && task === null && (
              <span class="proposal-name">
                {taskFailing(taskId) ? UNREAD_NAME : GONE_NAME}
              </span>
            )}
            <span class="proposal-state">{INERT_WORDS}</span>
          </span>
        </span>
      </div>
    </div>
  );
}

export function Proposal({ line }: { line: ProposalLine }) {
  if (line.kind === "inert") return <Inert line={line} />;
  return <Draft draft={line.draft} />;
}

function Draft({ draft }: { draft: AutomationDraft }) {
  const head = lineHead(draft);
  // only "confirmed by @user, 3m ago" moves with the clock
  const now = useNow(
    head.by === null ? null : agoTickMs(head.by.at, Date.now()),
  );
  const open = useSignal(false);
  const press = useAction();
  const taskId = draft.automationId;
  // after every draw, so a read that failed is asked again later
  useEffect(() => {
    if (taskId !== null) void loadDraftTask(taskId);
  });
  const before = taskId === null ? null : draftTask(taskId);
  if (before === undefined) return null;
  // a rename's new name shows in its details until it is confirmed
  const renamed =
    draft.action === "update" && draft.state === "confirmed"
      ? draft.fields.name
      : undefined;
  const name =
    draft.action === "create"
      ? draft.fields.name
      : (renamed ??
        before?.name ??
        (taskId !== null && taskFailing(taskId) ? UNREAD_NAME : GONE_NAME));
  const detail = lineDetail(draft);
  const target = nameTarget(draft, before !== null);
  const pending = draft.state === "pending";
  // without the task's old values an update's details would hide what
  // changes, so a failing read opens nothing until it answers
  const shows = opens(draft) && !(taskId !== null && taskFailing(taskId));
  const decide = (action: "confirm" | "dismiss") =>
    void press.run(() => decideDraft(draft.id, action));
  return (
    <div class={`proposal proposal-${draft.state}`}>
      <div class="proposal-row">
        <span class="proposal-line">
          <span class="proposal-lead">
            {shows ? (
              <button
                type="button"
                class="proposal-toggle"
                aria-expanded={open.value}
                aria-label={open.value ? "Hide details" : "Show details"}
                onClick={() => {
                  open.value = !open.value;
                }}
              >
                <Icon
                  name="chevron-right"
                  size={12}
                  class={`proposal-chevron${open.value ? " proposal-chevron-open" : ""}`}
                />
              </button>
            ) : (
              <span class="proposal-toggle" />
            )}
            <Icon name={head.icon} size={12} class="proposal-icon" />
          </span>
          <span class="proposal-main">
            <span class="proposal-kind">{head.title}</span>
            {target === null ? (
              <span class="proposal-name">{name}</span>
            ) : (
              <a
                class="proposal-name"
                href={
                  target.kind === "run"
                    ? runHref(target.id)
                    : automationHref(target.id)
                }
              >
                {name}
              </a>
            )}
            {detail !== null && detail !== "" && (
              <span class="proposal-detail">{detail}</span>
            )}
            {!pending && (
              <span class="proposal-state">
                {head.by !== null ? (
                  <>
                    {head.by.verb} by{" "}
                    <a class="proposal-user" href={userHref(head.by.username)}>
                      @{head.by.username}
                    </a>
                    , {ago(head.by.at, now)}
                  </>
                ) : (
                  head.note
                )}
              </span>
            )}
          </span>
        </span>
        {pending && (
          <span class="proposal-buttons">
            <button
              type="button"
              class="btn btn-small"
              disabled={press.busy.value}
              onClick={() => decide("dismiss")}
            >
              Dismiss
            </button>
            <button
              type="button"
              class="btn btn-small proposal-confirm"
              disabled={press.busy.value}
              onClick={() => decide("confirm")}
            >
              Confirm
            </button>
          </span>
        )}
      </div>
      {pending && press.failure.value !== null && (
        <p class="proposal-failed">{press.failure.value}</p>
      )}
      {shows && open.value && <Details draft={draft} before={before} />}
    </div>
  );
}
