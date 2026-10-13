// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task's activity, oldest first, one line per entry: its
// icon, its verb, who made a move that changes who holds the task, the
// first line of its words, and when. A line with words opens them under
// it on a click, rendered as Markdown with the links the text leaves
// out. The waiting question starts open with the answer box at its
// foot; on a task in progress the latest report starts open. Earlier
// entries load with Show earlier at the top.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import type { ExternalTaskPageEntry } from "../../../shared/contracts/external-task.ts";
import { loadMoreEntries, type TaskPage } from "../../data/external-task.ts";
import { ago } from "../../lib/format.ts";
import { chatHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { RowsFailed, RowsMore } from "../../ui/Rows.tsx";
import { TaskStateIcon } from "./ExternalTaskRow.tsx";
import {
  chatName,
  GONE_USER,
  sweepReason,
  webLink,
} from "./ExternalTasks.model.ts";
import {
  activityOf,
  ENTRY_ICONS,
  REPORTS,
  VERBS,
} from "./ExternalTaskTimeline.model.ts";
import "../../transcript/md.css";

// the waiting question's line, which the page's state line jumps to
export const QUESTION_ID = "question";

// the words as the server rendered them, then the links they leave out
export function Body({ entry }: { entry: ExternalTaskPageEntry }) {
  const extra = entry.links.filter((link) => !entry.text.includes(link));
  return (
    <>
      <div
        class="md-wide external-tasks-md"
        // the server renders the markdown with raw HTML off: render/ is
        // the safety boundary
        dangerouslySetInnerHTML={{ __html: entry.html }}
      />
      {extra.map((link) =>
        webLink(link) ? (
          <a
            key={link}
            class="external-tasks-link cut"
            href={link}
            target="_blank"
            rel="noopener"
          >
            {link}
          </a>
        ) : (
          <span key={link} class="external-tasks-link-text cut">
            {link}
          </span>
        ),
      )}
    </>
  );
}

// who made a move, as plain words: the line is the click target, so no
// link sits inside it; 1ctx, on its own releases, and a deleted user
// faint
export function Who({
  username,
  keyName,
  system = false,
}: {
  username: string | null;
  keyName: string | null;
  system?: boolean;
}) {
  return (
    <span class="external-tasks-line-who">
      <span class="external-tasks-line-via">by</span>
      {username === null && system ? (
        <span class="external-tasks-by-faint">1ctx</span>
      ) : username === null ? (
        <span class="external-tasks-by-faint">{GONE_USER}</span>
      ) : (
        <span class="external-tasks-line-user cut">@{username}</span>
      )}
      {keyName !== null && (
        <>
          <span class="external-tasks-line-via">via</span>
          <span class="tag external-tasks-key" title={keyName}>
            {keyName}
          </span>
        </>
      )}
    </span>
  );
}

function Line({
  icon,
  verb,
  who,
  place,
  text,
  at,
  now,
  open: start = false,
  id,
  children,
}: {
  icon: ComponentChildren;
  verb: string;
  who?: ComponentChildren;
  // where it happened, after who
  place?: ComponentChildren;
  text: string;
  at: number;
  now: number;
  open?: boolean;
  id?: string;
  children?: ComponentChildren;
}) {
  const open = useSignal(start);
  const body = children !== undefined && children !== null;
  const words = (
    <>
      {icon}
      <span class="external-tasks-line-verb">{verb}</span>
      {who}
      {place}
      <span class="external-tasks-line-text cut">{open.value ? "" : text}</span>
      <span class="external-tasks-when">{ago(at, now)}</span>
    </>
  );
  return (
    <li id={id} class={id === undefined ? undefined : "external-tasks-jump"}>
      {body ? (
        <button
          type="button"
          class="external-tasks-line external-tasks-line-go"
          aria-expanded={open.value}
          onClick={() => {
            open.value = !open.value;
          }}
        >
          {words}
        </button>
      ) : (
        <div class="external-tasks-line">{words}</div>
      )}
      {body && open.value && (
        <div class="external-tasks-line-body">{children}</div>
      )}
    </li>
  );
}

// the first line: who opened the task, and in which chat when the
// reader may open it
function Opened({ page, now }: { page: TaskPage; now: number }) {
  const { task, chatId, chatTitle } = page.detail;
  return (
    <Line
      icon={<TaskStateIcon state="todo" size={14} />}
      verb="Opened"
      who={<Who username={task.createdBy?.username ?? null} keyName={null} />}
      place={
        chatId === null ? undefined : (
          <span class="external-tasks-line-place">
            <span class="external-tasks-line-via">in</span>
            {chatTitle === null ? (
              <span>a chat</span>
            ) : (
              <a class="external-tasks-line-chat cut" href={chatHref(chatId)}>
                {chatName(chatTitle)}
              </a>
            )}
          </span>
        )
      }
      text=""
      at={task.createdAt}
      now={now}
    />
  );
}

export function Activity({
  page,
  now,
  answer,
}: {
  page: TaskPage;
  now: number;
  // the answer box, at the foot of the waiting question
  answer: ComponentChildren;
}) {
  const lines = activityOf(page.entries, page.detail.task);
  return (
    <section class="external-tasks-activity" aria-label="Activity">
      <h2 class="label external-tasks-activity-label">Activity</h2>
      <ol class="external-tasks-stream">
        {page.next !== null ? (
          <li class="external-tasks-earlier">
            {page.more.error !== null && (
              <RowsFailed failure={page.more.error} />
            )}
            <RowsMore onClick={() => void loadMoreEntries()}>
              {page.more.loading ? "Loading" : "Show earlier"}
            </RowsMore>
          </li>
        ) : (
          <Opened page={page} now={now} />
        )}
        {lines.map((line) => {
          const { entry } = line;
          return (
            <Line
              key={entry.id}
              icon={
                entry.kind === "claim" ? (
                  // a claim puts the task in progress, so it wears that ring
                  <TaskStateIcon state="in_progress" size={14} />
                ) : (
                  <Icon
                    name={ENTRY_ICONS[entry.kind]}
                    size={14}
                    class={`external-tasks-line-icon${
                      line.waiting ? " status-attention" : ""
                    }`}
                  />
                )
              }
              verb={VERBS[entry.kind]}
              who={
                REPORTS.has(entry.kind) ? undefined : (
                  <Who
                    username={entry.by?.username ?? null}
                    keyName={entry.keyName}
                    system={sweepReason(entry) !== null}
                  />
                )
              }
              text={line.line}
              at={entry.at}
              now={now}
              open={line.open}
              id={line.waiting ? QUESTION_ID : undefined}
            >
              {entry.text === "" ? null : (
                <>
                  {line.question !== null && (
                    <p class="external-tasks-entry-pair cut">
                      <Icon
                        name="question"
                        size={12}
                        class="external-tasks-entry-pair-icon"
                      />
                      {line.question}
                    </p>
                  )}
                  <Body entry={entry} />
                  {line.waiting && answer}
                </>
              )}
            </Line>
          );
        })}
      </ol>
      {page.detail.task.state === "awaiting_input" &&
        !lines.some((line) => line.waiting && line.entry.text !== "") &&
        answer}
    </section>
  );
}
