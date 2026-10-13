// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task's page. The title is its heading, with one line
// under it saying the state and when it last moved, and on a phone the
// labels. A move's box opens at the top of the body; then, while todo,
// the notice to claim it, a done task's result, the files, and the
// activity. An edit shows only the form: the rest waits under it, a
// draft kept. The aside has the labels, who holds the claim and when it
// ends, and when the task was made and edited. Frames keep it current.

import { useSignal } from "@preact/signals";
import type {
  ExternalTaskDetail,
  ExternalTaskRow,
} from "../../../shared/contracts/external-task.ts";
import { EXTERNAL_TASK_STATE_WORDS } from "../../../shared/words.ts";
import type { Params } from "../../app/params.ts";
import {
  type TaskPage,
  taskError,
  taskPage,
} from "../../data/external-task.ts";
import { project } from "../../data/projects.ts";
import { ago, longDate } from "../../lib/format.ts";
import { externalTasksHref, userHref } from "../../lib/hrefs.ts";
import { useNow } from "../../lib/now.ts";
import { Page } from "../../ui/Page.tsx";
import {
  AsideHandle,
  AsideLine,
  AsideNames,
  AsideSection,
  Split,
} from "../../ui/Split.tsx";
import { TaskFiles } from "./ExternalTaskFiles.tsx";
import { TaskForm } from "./ExternalTaskForm.tsx";
import {
  Answer,
  HeadMoves,
  MoveBoxes,
  type MoveState,
  useMoveState,
} from "./ExternalTaskMoves.tsx";
import { TaskStateIcon, TaskTags } from "./ExternalTaskRow.tsx";
import {
  claimDeadline,
  deadlineTime,
  movedWords,
  UNCLAIMED,
} from "./ExternalTasks.model.ts";
import { ConnectNotice } from "./ExternalTasks.tsx";
import { Activity, Body, QUESTION_ID, Who } from "./ExternalTaskTimeline.tsx";
import "./external-tasks.css";

// the router takes every in-app click and drops a hash, so the jump to
// the waiting question scrolls here
export function jumpToQuestion(event: Event): void {
  event.preventDefault();
  document
    .getElementById(QUESTION_ID)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// the title as the page's heading, then where the task stands
function Head({ task, now }: { task: ExternalTaskRow; now: number }) {
  const words = EXTERNAL_TASK_STATE_WORDS[task.state];
  return (
    <header class="external-tasks-head">
      <h2 class="external-tasks-title">{task.title}</h2>
      <p class="external-tasks-status">
        <span class="external-tasks-status-state">
          <TaskStateIcon state={task.state} size={16} />
          {task.state === "awaiting_input" ? (
            <a
              class="external-tasks-status-jump"
              href={`#${QUESTION_ID}`}
              onClick={jumpToQuestion}
            >
              {words}
            </a>
          ) : (
            words
          )}
        </span>
        <span class="external-tasks-status-faint">
          {movedWords(task)} {ago(task.movedAt, now)}
        </span>
      </p>
      {task.labels.length > 0 && (
        <p class="external-tasks-head-labels external-tasks-narrow">
          <TaskTags labels={task.labels} />
        </p>
      )}
    </header>
  );
}

// a done task leads with its result, whole
function Result({ page, now }: { page: TaskPage; now: number }) {
  if (page.detail.task.state !== "done") return null;
  const entry = page.entries.find((e) => e.kind === "result");
  if (entry === undefined) return null;
  return (
    <section class="card external-tasks-result" aria-label="Result">
      <p class="external-tasks-result-head">
        <TaskStateIcon state="done" size={14} />
        <span class="external-tasks-result-kind">Result</span>
        <Who username={entry.by?.username ?? null} keyName={entry.keyName} />
        <span class="external-tasks-when">{ago(entry.at, now)}</span>
      </p>
      <Body entry={entry} />
    </section>
  );
}

function Aside({
  detail,
  idle,
  now,
}: {
  detail: ExternalTaskDetail;
  idle: number;
  now: number;
}) {
  const task = detail.task;
  const deadline = claimDeadline(task, idle);
  return (
    <AsideSection label="Task">
      {task.labels.length > 0 && (
        <AsideLine label="Labels">
          <span class="external-tasks-aside-labels">
            <TaskTags labels={task.labels} />
          </span>
        </AsideLine>
      )}
      {task.claim !== null && (
        <AsideLine label="Claimed by">
          <AsideHandle
            name={task.claim.username}
            href={userHref(task.claim.username)}
          />{" "}
          via <AsideNames names={[task.claim.keyName]} />
        </AsideLine>
      )}
      {deadline !== null && (
        <AsideLine label="Claim ends">{deadlineTime(deadline, now)}</AsideLine>
      )}
      <AsideLine label="Created">{longDate(task.createdAt)}</AsideLine>
      {detail.briefAt > task.createdAt && (
        <AsideLine label="Edited">{ago(detail.briefAt, now)}</AsideLine>
      )}
    </AsideSection>
  );
}

// a todo task waits for an agent, so the page says where to connect one
export function TaskNotice({ state }: Pick<ExternalTaskRow, "state">) {
  return state === "todo" ? <ConnectNotice words={UNCLAIMED} /> : undefined;
}

// the page under its head: the title or the form, then the rest, which
// an open form hides without dropping a draft
export function TaskBody({
  page,
  moves,
  now,
  edit,
  onClose,
}: {
  page: TaskPage;
  moves: MoveState;
  now: number;
  edit: boolean;
  onClose: () => void;
}) {
  const task = page.detail.task;
  return (
    <Split
      aside={<Aside detail={page.detail} idle={page.idleHours} now={now} />}
    >
      {edit ? (
        <TaskForm
          key={task.id}
          projectId={task.projectId}
          detail={page.detail}
          onCancel={onClose}
          onSaved={onClose}
        />
      ) : (
        <Head task={task} now={now} />
      )}
      <div class="external-tasks-rest" hidden={edit}>
        <MoveBoxes task={task} moves={moves} />
        {TaskNotice(task)}
        <Result page={page} now={now} />
        <TaskFiles detail={page.detail} />
        <Activity
          page={page}
          now={now}
          answer={<Answer task={task} text={moves.answer} />}
        />
      </div>
    </Split>
  );
}

// keyed by the task, so a box, an answer's draft or an open form never
// follows the reader to another task
export function ExternalTask({ params }: { params: Params }) {
  const id = params.id ?? "";
  return <TaskScreen key={id} id={id} />;
}

function TaskScreen({ id }: { id: string }) {
  const page = taskPage.value?.id === id ? taskPage.value : null;
  const error = taskError.value;
  const editing = useSignal<string | null>(null);
  const moves = useMoveState();
  const now = useNow(60_000);
  const task = page?.detail.task ?? null;
  const shown =
    task !== null && project.value?.id === task.projectId
      ? project.value
      : null;
  const tab = task === null ? undefined : externalTasksHref(task.projectId);
  return (
    <Page
      steps={[{ label: shown?.name ?? "Project", href: tab }]}
      split
      title="External tasks"
      titleHref={tab}
      actions={
        task === null ? undefined : (
          <HeadMoves
            task={task}
            moves={moves}
            onEdit={
              editing.value === id
                ? null
                : () => {
                    editing.value = id;
                  }
            }
          />
        )
      }
      loading={page === null && error === null}
      error={page === null ? error : null}
    >
      {page !== null && (
        <TaskBody
          page={page}
          moves={moves}
          now={now}
          // an edit belongs to the task it opened on
          edit={editing.value === id}
          onClose={() => {
            editing.value = null;
          }}
        />
      )}
    </Page>
  );
}
