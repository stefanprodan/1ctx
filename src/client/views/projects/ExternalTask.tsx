// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task's page: the brief (its state with the state's icon,
// the chat it was made in, the text cut to a few lines, the linked
// files, a deleted one marked), edited in place while the task is
// unfinished; the member's moves; the answer box while blocked; then
// the timeline. An edit shows only the form: the moves, the answer box
// and the timeline wait under it, a draft kept. The aside has the
// scope, who made it and when, and while claimed when the idle sweep
// unclaims it; on a phone the scope and that time sit under the files.
// Frames keep it current, and a mark is cleared once it is read.

import { useSignal } from "@preact/signals";
import type {
  ExternalTaskDetail,
  ExternalTaskRow,
} from "../../../shared/contracts/external-task.ts";
import type { Params } from "../../app/params.ts";
import {
  type TaskPage,
  taskError,
  taskPage,
} from "../../data/external-task.ts";
import { project } from "../../data/projects.ts";
import { ago, longDate } from "../../lib/format.ts";
import { chatHref, externalTasksHref, userHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { useCut } from "../../lib/resize.ts";
import { Fold } from "../../ui/Fold.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsGo, RowsLine, RowsList, RowsTitle } from "../../ui/Rows.tsx";
import {
  AsideHandle,
  AsideLine,
  AsideNames,
  AsideSection,
  Split,
} from "../../ui/Split.tsx";
import { fileHref } from "../knowledge/Knowledge.model.ts";
import { TaskForm } from "./ExternalTaskForm.tsx";
import { Answer, TaskMoves } from "./ExternalTaskMoves.tsx";
import {
  chatName,
  claimDeadline,
  deadlineTime,
  fileLabel,
  stateLine,
  taskIcon,
  UNCLAIMED,
} from "./ExternalTasks.model.ts";
import { ConnectNotice } from "./ExternalTasks.tsx";
import { Timeline } from "./ExternalTaskTimeline.tsx";
import "./external-tasks.css";

// the chat's title and link only when the server says the reader may
// open it
function MadeIn({ detail }: { detail: ExternalTaskDetail }) {
  if (detail.chatId === null) return null;
  return (
    <p class="external-tasks-brief-foot">
      {detail.chatTitle === null ? (
        <span>Made in a chat</span>
      ) : (
        <span class="external-tasks-chat">
          <span>Made in</span>
          <a class="cut" href={chatHref(detail.chatId)}>
            {chatName(detail.chatTitle)}
          </a>
        </span>
      )}
    </p>
  );
}

// the state's icon in its colour, then its words, for the phone line
function State({ task }: { task: ExternalTaskDetail["task"] }) {
  const icon = taskIcon(task);
  return (
    <span class="external-tasks-state">
      <Icon
        name={icon.name}
        size={14}
        class={`external-tasks-state-icon${icon.status === null ? "" : ` status-${icon.status}`}`}
      />
      <span>{stateLine(task)}</span>
    </span>
  );
}

function Brief({
  detail,
  idle,
  now,
}: {
  detail: ExternalTaskDetail;
  idle: number;
  now: number;
}) {
  const task = detail.task;
  const { el, open, long } = useCut<HTMLParagraphElement>([detail.text]);
  const deadline = claimDeadline(task, idle);
  return (
    <section class="card external-tasks-brief">
      <div class="external-tasks-brief-text">
        <Fold
          cut={long.value && !open.value}
          onOpen={() => {
            open.value = true;
          }}
          label="Show all"
        >
          <p
            ref={el}
            class={`external-tasks-brief-body${open.value ? "" : " clamp"}`}
          >
            {detail.text}
          </p>
        </Fold>
      </div>
      {detail.files.length > 0 && (
        <RowsList>
          {detail.files.map((file) =>
            file.deleted ? (
              <RowsLine key={file.fileId} flush off>
                <RowsTitle name={fileLabel(file)} mono />
              </RowsLine>
            ) : (
              <RowsGo
                key={file.fileId}
                href={fileHref(task.projectId, file.fileId)}
              >
                <RowsTitle name={fileLabel(file)} mono />
              </RowsGo>
            ),
          )}
        </RowsList>
      )}
      <p class="external-tasks-brief-foot external-tasks-brief-narrow">
        <State task={task} />
        {deadline !== null && (
          <span>Claim ends {deadlineTime(deadline, now)}</span>
        )}
        {task.scope !== null && <span>Scope: {task.scope}</span>}
      </p>
      <MadeIn detail={detail} />
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
      <AsideLine label="State">{task.state}</AsideLine>
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
      {task.scope !== null && <AsideLine label="Scope">{task.scope}</AsideLine>}
      {task.createdBy !== null && (
        <AsideLine label="Created by" href={userHref(task.createdBy.username)}>
          @{task.createdBy.username}
        </AsideLine>
      )}
      <AsideLine label="Created">{longDate(task.createdAt)}</AsideLine>
      {detail.briefAt > task.createdAt && (
        <AsideLine label="Brief edited">{ago(detail.briefAt, now)}</AsideLine>
      )}
    </AsideSection>
  );
}

// an open task waits for an agent, so the page says where to connect one
export function TaskNotice({ state }: Pick<ExternalTaskRow, "state">) {
  return state === "open" ? <ConnectNotice words={UNCLAIMED} /> : undefined;
}

// the page under its title: the brief or its form, then the rest, which
// an open form hides without dropping a draft
export function TaskBody({
  page,
  now,
  edit,
  onEdit,
  onClose,
}: {
  page: TaskPage;
  now: number;
  edit: boolean;
  onEdit: () => void;
  onClose: () => void;
}) {
  const task = page.detail.task;
  return (
    <Split
      aside={<Aside detail={page.detail} idle={page.idleHours} now={now} />}
    >
      {!edit && TaskNotice(task)}
      {edit ? (
        <TaskForm
          key={task.id}
          projectId={task.projectId}
          detail={page.detail}
          onCancel={onClose}
          onSaved={onClose}
        />
      ) : (
        <Brief detail={page.detail} idle={page.idleHours} now={now} />
      )}
      <div class="external-tasks-rest" hidden={edit}>
        <TaskMoves task={task} onEdit={edit ? null : onEdit} />
        <Answer
          key={task.id}
          task={task}
          question={
            page.entries.find((e) => e.kind === "question")?.text ?? null
          }
        />
        <Timeline page={page} now={now} />
      </div>
    </Split>
  );
}

export function ExternalTask({ params }: { params: Params }) {
  const id = params.id ?? "";
  const page = taskPage.value?.id === id ? taskPage.value : null;
  const error = taskError.value;
  const editing = useSignal<string | null>(null);
  const now = useNow(60_000);
  const task = page?.detail.task ?? null;
  const shown =
    task !== null && project.value?.id === task.projectId
      ? project.value
      : null;
  return (
    <Page
      crumb={shown?.name ?? "Project"}
      crumbHref={task === null ? undefined : externalTasksHref(task.projectId)}
      title={task?.title ?? "External task"}
      loading={page === null && error === null}
      error={page === null ? error : null}
    >
      {page !== null && (
        <TaskBody
          page={page}
          now={now}
          // an edit belongs to the task it opened on
          edit={editing.value === id}
          onEdit={() => {
            editing.value = id;
          }}
          onClose={() => {
            editing.value = null;
          }}
        />
      )}
    </Page>
  );
}
