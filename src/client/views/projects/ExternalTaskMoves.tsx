// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A member's moves on an external task's page. Unclaim, Drop and Reopen
// open a box for the words the timeline keeps; the box names the state
// and the claim the page showed when it opened, so a task moved since
// is refused with the server's words rather than moved blind. Delete
// asks in place. The answer box shows the open question while the task
// is blocked, and stays while it holds a draft. A box whose move the
// task no longer offers keeps its words and its refusal, and its button
// is off.

import { useSignal } from "@preact/signals";
import type { ExternalTaskRow } from "../../../shared/contracts/external-task.ts";
import type { ExternalTaskState } from "../../../shared/words.ts";
import { navigate } from "../../app/router.ts";
import {
  deleteExternalTask,
  moveExternalTask,
} from "../../data/external-task.ts";
import { externalTasksHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { noticeOf, useSave } from "../../lib/save.ts";
import { CodeTag } from "../../ui/CodeTag.tsx";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import { MOVE_WORDS, type Move, movesOf } from "./ExternalTasks.model.ts";

type Opened = { move: Move; state: ExternalTaskState; claimId?: string };

// the words a move keeps, and its button
function MoveBox({
  task,
  opened,
  onClose,
}: {
  task: ExternalTaskRow;
  opened: Opened;
  onClose: () => void;
}) {
  const text = useSignal("");
  const words = MOVE_WORDS[opened.move];
  const offered = movesOf(task.state)[opened.move];
  const save = useSave(async () => {
    const said = text.value.trim();
    await moveExternalTask(task.id, opened.move, {
      state: opened.state,
      ...(said === "" ? {} : { text: said }),
      ...(opened.claimId === undefined ? {} : { claimId: opened.claimId }),
    });
    onClose();
  });
  return (
    <form
      class="card external-tasks-box"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
      <label class="field">
        <span class={`label${words.required ? " label-required" : ""}`}>
          Reason
        </span>
        <textarea
          name="text"
          rows={3}
          disabled={save.busy}
          value={text.value}
          onInput={save.bind(text)}
        />
      </label>
      <Foot
        save={save}
        dirty={offered && (!words.required || text.value.trim() !== "")}
        label={words.label}
        before={
          <button
            type="button"
            class="btn"
            disabled={save.busy}
            onClick={onClose}
          >
            Cancel
          </button>
        }
      />
    </form>
  );
}

export function Answer({
  task,
  question,
}: {
  task: ExternalTaskRow;
  // the latest question's text, from the entries read
  question: string | null;
}) {
  const text = useSignal("");
  const save = useSave(async () => {
    await moveExternalTask(task.id, "answer", {
      state: task.state,
      text: text.value.trim(),
    });
    text.value = "";
  });
  if (task.state !== "blocked" && text.value === "") return null;
  return (
    <form
      class="card external-tasks-box"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
      {question !== null && (
        <div class="external-tasks-question">
          <span class="label">Question</span>
          <p class="external-tasks-question-text clamp">{question}</p>
        </div>
      )}
      <label class="field">
        <textarea
          name="text"
          aria-label="Answer"
          rows={4}
          disabled={save.busy}
          value={text.value}
          onInput={save.bind(text)}
        />
      </label>
      <Foot save={save} dirty={text.value.trim() !== ""} label="Answer" />
    </form>
  );
}

export function TaskMoves({
  task,
  onEdit,
}: {
  task: ExternalTaskRow;
  // null while the brief is being edited
  onEdit: (() => void) | null;
}) {
  const opened = useSignal<Opened | null>(null);
  const asking = useSignal(false);
  const save = useSave(async () => {});
  const moves = movesOf(task.state);
  const open = (move: Move) => {
    save.touch();
    opened.value = {
      move,
      state: task.state,
      ...(move === "unclaim" && task.claim !== null
        ? { claimId: task.claim.id }
        : {}),
    };
  };
  const remove = async () => {
    const projectId = task.projectId;
    if (await save.act("delete", () => deleteExternalTask(task.id))) {
      navigate(externalTasksHref(projectId));
    }
  };
  const notice = save.notice();
  const busy = save.busy || opened.value !== null;
  const button = (move: Move, icon: "redo" | "close" | "play") => (
    <button
      key={move}
      type="button"
      class="btn btn-small"
      disabled={busy}
      onClick={() => open(move)}
    >
      <Icon name={icon} size={12} />
      {MOVE_WORDS[move].label}
    </button>
  );
  return (
    <>
      <div class="external-tasks-actions">
        {!asking.value && (
          <>
            {moves.edit && onEdit !== null && (
              <button
                type="button"
                class="btn btn-small"
                disabled={busy}
                onClick={onEdit}
              >
                <Icon name="pencil" size={12} />
                Edit
              </button>
            )}
            {moves.unclaim && button("unclaim", "redo")}
            {moves.drop && button("drop", "close")}
            {moves.reopen && button("reopen", "play")}
          </>
        )}
        <div class="external-tasks-actions-end">
          <AskDelete
            save={save}
            asking={asking}
            busy={busy}
            small
            onDelete={() => void remove()}
          />
        </div>
      </div>
      {notice !== null && (
        <p class="notice-failed" role="alert">
          {noticeOf(notice)}
          <CodeTag status={notice.status} spaced />
        </p>
      )}
      {opened.value !== null && (
        <MoveBox
          key={opened.value.move}
          task={task}
          opened={opened.value}
          onClose={() => {
            opened.value = null;
          }}
        />
      )}
    </>
  );
}
