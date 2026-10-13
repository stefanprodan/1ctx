// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A member's moves on an external task's page. The head holds them: a
// closed task's Reopen as its one button, then Edit, Unclaim, Cancel
// task and Delete in its More menu. A move opens its box at the top of
// the body for the words the activity keeps; the box names the state
// and the claim the page showed when it opened, so a task moved since
// is refused with the server's words rather than moved blind. Delete
// asks there too. The answer box sits at the foot of the waiting
// question. A box whose move the task no longer offers keeps its words
// and its refusal, and its button is off.

import { type Signal, useSignal } from "@preact/signals";
import type { ExternalTaskRow } from "../../../shared/contracts/external-task.ts";
import type { ExternalTaskState } from "../../../shared/words.ts";
import { navigate } from "../../app/router.ts";
import {
  deleteExternalTask,
  moveExternalTask,
} from "../../data/external-task.ts";
import { tasksTabHref } from "../../data/external-tasks.ts";
import { Icon } from "../../lib/icons.tsx";
import { noticeOf, useSave } from "../../lib/save.ts";
import { CodeTag } from "../../ui/CodeTag.tsx";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import { type MoreAction, MoreMenu } from "../knowledge/file/DocMenus.tsx";
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

// the draft lives in the page's move state, so folding the question's
// line away and back keeps what was typed
export function Answer({
  task,
  text,
}: {
  task: ExternalTaskRow;
  text: Signal<string>;
}) {
  const save = useSave(async () => {
    await moveExternalTask(task.id, "answer", {
      state: task.state,
      text: text.value.trim(),
    });
    text.value = "";
  });
  if (task.state !== "awaiting_input" && text.value === "") return null;
  return (
    <form
      class="external-tasks-answer"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
      <label class="field">
        <textarea
          name="text"
          aria-label="Answer"
          placeholder="Answer the question"
          rows={3}
          disabled={save.busy}
          value={text.value}
          onInput={save.bind(text)}
        />
      </label>
      <Foot save={save} dirty={text.value.trim() !== ""} label="Answer" />
    </form>
  );
}

// the moves' state, made by the page so the head's buttons and the
// body's boxes share it
export function useMoveState() {
  return {
    opened: useSignal<Opened | null>(null),
    asking: useSignal(false),
    answer: useSignal(""),
    save: useSave(async () => {}),
  };
}
export type MoveState = ReturnType<typeof useMoveState>;

// the head's moves: the one a closed task wants as a button, the rest
// in More, Delete last
export function HeadMoves({
  task,
  moves: state,
  onEdit,
}: {
  task: ExternalTaskRow;
  moves: MoveState;
  // null while the brief is being edited
  onEdit: (() => void) | null;
}) {
  const { opened, asking, save } = state;
  if (onEdit === null) return null;
  const moves = movesOf(task.state);
  const open = (move: Move) => {
    save.touch();
    asking.value = false;
    opened.value = {
      move,
      state: task.state,
      ...(move === "unclaim" && task.claim !== null
        ? { claimId: task.claim.id }
        : {}),
    };
  };
  const actions: MoreAction[] = [
    ...(moves.edit
      ? [{ label: "Edit", icon: "pencil" as const, onPick: onEdit }]
      : []),
    ...(moves.unclaim
      ? [
          {
            label: MOVE_WORDS.unclaim.label,
            icon: "sign-out" as const,
            onPick: () => open("unclaim"),
          },
        ]
      : []),
    ...(moves.cancel
      ? [
          {
            label: MOVE_WORDS.cancel.label,
            icon: "cancelled" as const,
            onPick: () => open("cancel"),
          },
        ]
      : []),
    {
      label: "Delete",
      icon: "trash",
      danger: true,
      onPick: () => {
        opened.value = null;
        asking.value = true;
      },
    },
  ];
  return (
    <div class="external-tasks-head-moves">
      {moves.reopen && (
        <button
          type="button"
          class="btn btn-small"
          disabled={save.busy || opened.value !== null}
          onClick={() => open("reopen")}
        >
          <Icon name="redo" size={12} />
          {MOVE_WORDS.reopen.label}
        </button>
      )}
      <MoreMenu actions={actions} />
    </div>
  );
}

// what a move opens, at the top of the page's body: its box, or the
// delete ask
export function MoveBoxes({
  task,
  moves: state,
}: {
  task: ExternalTaskRow;
  moves: MoveState;
}) {
  const { opened, asking, save } = state;
  const remove = async () => {
    const projectId = task.projectId;
    if (await save.act("delete", () => deleteExternalTask(task.id))) {
      navigate(tasksTabHref(projectId));
    }
  };
  const notice = save.notice();
  return (
    <>
      {asking.value && (
        <div class="card external-tasks-box external-tasks-ask">
          <span>Delete this task and its activity?</span>
          <div class="external-tasks-actions-end">
            <AskDelete
              save={save}
              asking={asking}
              busy={save.busy}
              small
              onDelete={() => void remove()}
            />
          </div>
        </div>
      )}
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
