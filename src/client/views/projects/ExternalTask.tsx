// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task's page: the brief (its scope and state, the text cut
// to a few lines, the linked files, a deleted one marked), edited in
// place while the task is unfinished; the member's moves; the answer
// box while blocked; then the timeline. The aside has who made it and
// holds it. Frames keep it current, and a mark is cleared once it is
// read.

import { useSignal } from "@preact/signals";
import type { ExternalTaskDetail } from "../../../shared/contracts/external-task.ts";
import type { Params } from "../../app/params.ts";
import { taskError, taskPage } from "../../data/external-task.ts";
import { project } from "../../data/projects.ts";
import { ago, longDate } from "../../lib/format.ts";
import { chatHref, externalTasksHref, userHref } from "../../lib/hrefs.ts";
import { useNow } from "../../lib/now.ts";
import { useCut } from "../../lib/resize.ts";
import { Fold } from "../../ui/Fold.tsx";
import { Page } from "../../ui/Page.tsx";
import {
  RowsGo,
  RowsLine,
  RowsList,
  RowsTag,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { fileHref } from "../knowledge/Knowledge.model.ts";
import { TaskForm } from "./ExternalTaskForm.tsx";
import { Answer, TaskMoves } from "./ExternalTaskMoves.tsx";
import { fileLabel, idleWords, stateLine } from "./ExternalTasks.model.ts";
import { Timeline } from "./ExternalTaskTimeline.tsx";
import "./external-tasks.css";

function Brief({ detail, idle }: { detail: ExternalTaskDetail; idle: number }) {
  const task = detail.task;
  const { el, open, long } = useCut<HTMLParagraphElement>([detail.text]);
  return (
    <section class="card external-tasks-brief">
      <p class="external-tasks-brief-line">
        {task.scope !== null && (
          <>
            <RowsTag>{task.scope}</RowsTag>{" "}
          </>
        )}
        {stateLine(task)}
      </p>
      {(task.state === "claimed" || detail.chatId !== null) && (
        <p class="external-tasks-brief-foot">
          {task.state === "claimed" && <span>{idleWords(idle)}</span>}
          {detail.chatId !== null && (
            <a href={chatHref(detail.chatId)}>Made in a chat</a>
          )}
        </p>
      )}
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
    </section>
  );
}

function Aside({ detail, now }: { detail: ExternalTaskDetail; now: number }) {
  const task = detail.task;
  return (
    <AsideSection label="Task">
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
  // an edit belongs to the task it opened on
  const edit = editing.value === id && page !== null;
  return (
    <Page
      crumb={shown?.name ?? "Project"}
      crumbHref={task === null ? undefined : externalTasksHref(task.projectId)}
      title={task?.title ?? "External task"}
      loading={page === null && error === null}
      error={page === null ? error : null}
    >
      {page !== null && task !== null && (
        <Split aside={<Aside detail={page.detail} now={now} />}>
          {edit ? (
            <TaskForm
              key={id}
              projectId={task.projectId}
              detail={page.detail}
              onCancel={() => {
                editing.value = null;
              }}
              onSaved={() => {
                editing.value = null;
              }}
            />
          ) : (
            <Brief detail={page.detail} idle={page.idleHours} />
          )}
          <TaskMoves
            task={task}
            onEdit={
              edit
                ? null
                : () => {
                    editing.value = id;
                  }
            }
          />
          <Answer
            key={id}
            task={task}
            question={
              page.entries.find((e) => e.kind === "question")?.text ?? null
            }
          />
          <Timeline page={page} now={now} />
        </Split>
      )}
    </Page>
  );
}
