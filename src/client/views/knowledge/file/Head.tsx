// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A live file's head: the notice and the buttons FileView.model.ts
// picks, drawn here so the view keeps the state and the calls alone.

import type {
  KnowledgeAuthor,
  KnowledgeFileView,
} from "../../../../shared/contracts/knowledge.ts";
import type { KnowledgeDraft } from "../../../data/knowledge-local.ts";
import type { DocDeleted } from "../../../data/knowledge-rows.ts";
import { ago, type Failure } from "../../../lib/format.ts";
import { Icon } from "../../../lib/icons.tsx";
import type { Problem } from "../../../lib/save.ts";
import { PageNotice } from "../../../ui/Page.tsx";
import { fileHref, listHref } from "../Knowledge.model.ts";
import { type MoreAction, MoreMenu } from "./DocMenus.tsx";
import type { ActionsKind, NoticeKind } from "./FileView.model.ts";
import { DeleteAsk, ProblemNotice, WroteNotice } from "./Notices.tsx";

export type HeadProps = {
  projectId: string;
  file: KnowledgeFileView;
  now: number;
  busy: boolean;
  // the action on its way, for its button's words
  pending: string | null;
  problem: Problem | null;
  // a read of the file again that failed, the text kept
  failure: Failure | null;
  // the live file a refused restore collided with
  openIt: string | null;
  days: number | null;
  deleted: DocDeleted | null;
  // the newest revision the page knows of
  latest: { author: KnowledgeAuthor; updatedAt: number; revision: number };
  offered: KnowledgeDraft | null;
  // an edit in this browser Restore brings back
  editKept: boolean;
  // the revision a Restore brought back and the one it replaced
  restored: { from: number; replaced: number } | null;
  saveable: boolean;
  renameReady: boolean;
  restorable: boolean;
  more: MoreAction[];
  on: {
    keep: () => void;
    remove: () => void;
    restoreFile: () => void;
    showLatest: () => void;
    discard: () => void;
    edit: () => void;
    cancelEdit: () => void;
    save: () => void;
    cancelRename: () => void;
    restoreRevision: () => void;
  };
};

// plain functions, not components: the head draws a notice row and
// the buttons' box only when there is something in them
export function headNotice(kind: NoticeKind, head: HeadProps) {
  const { on, now } = head;
  switch (kind) {
    case "problem":
      return head.problem === null ? null : (
        <ProblemNotice problem={head.problem}>
          {head.openIt !== null && (
            <a
              class="btn btn-small"
              href={fileHref(head.projectId, head.openIt)}
            >
              Open it
            </a>
          )}
        </ProblemNotice>
      );
    case "stale":
      return head.failure === null ? null : (
        <ProblemNotice
          problem={{
            error: head.failure.words,
            action: "load the latest",
            ...(head.failure.status === null
              ? {}
              : { status: head.failure.status }),
          }}
        />
      );
    case "delete":
      return (
        <DeleteAsk
          days={head.days}
          busy={head.busy}
          deleting={head.pending === "delete"}
          onKeep={on.keep}
          onDelete={on.remove}
        />
      );
    case "deleted":
      return head.deleted === null ? null : (
        <WroteNotice
          author={head.deleted.by}
          at={head.deleted.at}
          now={now}
          verb="deleted"
          after={` This is its last text.${
            head.editKept ? " Restore brings back your unsaved edit." : ""
          }`}
          failed
        >
          <button
            type="button"
            class="btn btn-small"
            disabled={head.busy}
            onClick={on.restoreFile}
          >
            Restore
          </button>
          <a class="btn btn-small" href={listHref(head.projectId, "files")}>
            Back to Knowledge
          </a>
        </WroteNotice>
      );
    case "conflict":
      return (
        <WroteNotice
          author={head.latest.author}
          at={head.latest.updatedAt}
          now={now}
          verb="changed"
          after=" Saving replaces their change. History keeps it."
          failed
        >
          <a
            class="btn btn-small"
            href={`${fileHref(head.projectId, head.file.id)}?revision=${
              head.latest.revision
            }`}
          >
            Show their change
          </a>
        </WroteNotice>
      );
    case "newer":
      return (
        <WroteNotice
          author={head.latest.author}
          at={head.latest.updatedAt}
          now={now}
          verb="changed"
        >
          <button type="button" class="btn btn-small" onClick={on.showLatest}>
            Show the latest
          </button>
        </WroteNotice>
      );
    case "restored":
      return head.restored === null ? null : (
        <PageNotice
          words={`Restored revision ${head.restored.from}. Revision ${head.restored.replaced} is in History.`}
        >
          <a
            class="btn btn-small"
            href={`${fileHref(head.projectId, head.file.id)}?revision=${
              head.restored.replaced
            }`}
          >
            Show revision {head.restored.replaced}
          </a>
        </PageNotice>
      );
    case "unbinned":
      return <PageNotice words="Restored from the bin." />;
    case "draft":
      return head.offered === null ? null : (
        <PageNotice
          words={`You have an unsaved edit of this file from ${ago(
            head.offered.savedAt,
            now,
          )}.${
            head.offered.revision !== null &&
            head.offered.revision < head.file.revision
              ? " The file changed since."
              : ""
          }`}
        >
          <button type="button" class="btn btn-small" onClick={on.discard}>
            Discard
          </button>
          <button
            type="button"
            class="btn btn-small btn-primary"
            onClick={on.edit}
          >
            Resume
          </button>
        </PageNotice>
      );
    default:
      return null;
  }
}

export function headActions(
  kind: ActionsKind,
  conflict: boolean,
  head: HeadProps,
) {
  const { on, busy, pending } = head;
  switch (kind) {
    case "edit":
      return (
        <>
          <button
            type="button"
            class="btn btn-small"
            disabled={busy}
            onClick={on.cancelEdit}
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-small btn-primary"
            disabled={busy || !head.saveable}
            onClick={on.save}
          >
            {pending === "save" ? "Saving" : conflict ? "Save anyway" : "Save"}
          </button>
        </>
      );
    case "rename":
      return (
        <>
          <button
            type="button"
            class="btn btn-small"
            disabled={busy}
            onClick={on.cancelRename}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="docpage-rename"
            class="btn btn-small btn-primary"
            disabled={busy || !head.renameReady}
          >
            {pending === "rename" ? "Renaming" : "Rename"}
          </button>
        </>
      );
    case "revision":
      return (
        <button
          type="button"
          class="btn btn-small btn-primary"
          disabled={busy || !head.restorable}
          onClick={on.restoreRevision}
        >
          <Icon name="redo" size={12} />
          {pending === "restore" ? "Restoring" : "Restore"}
        </button>
      );
    case "read":
      return (
        <>
          <button
            type="button"
            class="btn btn-small"
            aria-label="Edit"
            data-focus="edit"
            onClick={on.edit}
          >
            <Icon name="pencil" size={12} />
            <span class="docpage-word">Edit</span>
          </button>
          <MoreMenu actions={head.more} />
        </>
      );
    default:
      return null;
  }
}
