// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A live file's page. The head holds the file's tools, so they stay in
// view while the text scrolls, and its notices (Head.tsx, picked by
// FileView.model.ts). The card's band says which revision and who; its
// body is the whole file, the history, a past revision, the editor or
// the rename field. The aside is facts. This view keeps the state and
// makes the calls.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type {
  KnowledgeAuthor,
  KnowledgeFileView,
} from "../../../../shared/contracts/knowledge.ts";
import { navigate, query } from "../../../app/router.ts";
import { ApiError } from "../../../data/api.ts";
import { knowledgeOf } from "../../../data/knowledge.ts";
import {
  deleteFile,
  renameFile,
  restoreFile,
  saveFile,
  showLatest,
} from "../../../data/knowledge-file.ts";
import { historyOf } from "../../../data/knowledge-history.ts";
import {
  draftOf,
  dropDraft,
  keepDraft,
} from "../../../data/knowledge-local.ts";
import type { DocDeleted } from "../../../data/knowledge-rows.ts";
import type { Failure } from "../../../lib/format.ts";
import { useFocusField, useSave } from "../../../lib/save.ts";
import { touch } from "../../../lib/touch.ts";
import { baseName, foldersOf } from "../../../lib/tree.ts";
import { Page } from "../../../ui/Page.tsx";
import { Split } from "../../../ui/Split.tsx";
import {
  fileHref,
  historyHref,
  listHref,
  restoredHref,
} from "../Knowledge.model.ts";
import { fileActions } from "./DocMenus.tsx";
import {
  crumbSteps,
  isStale,
  numberParam,
  pathFieldOf,
  pathReady,
  shapePath,
} from "./DocPage.model.ts";
import { EditorBand, EditorBox } from "./Editor.tsx";
import {
  actionsKind,
  type Mode,
  noticeKind,
  saveRevision,
} from "./FileView.model.ts";
import { type HeadProps, headActions, headNotice } from "./Head.tsx";
import { History } from "./History.tsx";
import { PathField } from "./PathField.tsx";
import { Facts, Reader } from "./Reader.tsx";
import { Revision, revisionView } from "./Revision.tsx";
import "../../../transcript/md.css";
import "./docpage.css";

const EDIT_BUTTON = '.page-actions [data-focus="edit"]';
const MORE_BUTTON = '.page-actions [aria-label="More"]';

export function FileView({
  projectId,
  projectName,
  file,
  newer,
  deleted,
  failure,
  now,
}: {
  projectId: string;
  projectName: string;
  file: KnowledgeFileView;
  newer: {
    author: KnowledgeAuthor;
    updatedAt: number;
    revision: number;
  } | null;
  deleted: DocDeleted | null;
  failure: Failure | null;
  now: number;
}) {
  const fileId = file.id;
  const href = fileHref(projectId, fileId);
  const params = new URLSearchParams(query.value);
  const line = numberParam(params.get("line"));
  const revision = numberParam(params.get("revision"));
  const showHistory = params.has("history") && revision === null;
  const reading = revision === null && !showHistory;
  const list = knowledgeOf(projectId);

  const mode = useSignal<Mode>("read");
  const text = useSignal("");
  // the revision the editor started from, and its text for the counts
  const base = useSignal(0);
  const baseText = useSignal("");
  const path = useSignal("");
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {}, pathFieldOf);
  useFocusField(save, form);

  // where the focus goes once the next render has drawn it; a text box
  // takes it only from a pointer, since on a phone it opens the keyboard
  const focusNext = useRef<string | null>(null);
  const focusTo = (selector: string, field = false) => {
    if (!field || !touch()) focusNext.current = selector;
  };
  useEffect(() => {
    const selector = focusNext.current;
    if (selector === null) return;
    focusNext.current = null;
    document
      .querySelector<HTMLElement>(selector)
      ?.focus({ preventScroll: true });
  });

  const scope = { fileId };
  // a history, a past revision or a delete closes the editor; the edit
  // stays kept in this browser and is offered back
  const closes = !reading || deleted !== null;
  useEffect(() => {
    if (!closes || mode.value === "read") return;
    if (mode.value === "edit") keepDraft(scope, text.value, base.value);
    mode.value = "read";
  }, [closes]);

  const kept = draftOf(scope);
  const offered =
    mode.value === "read" && kept !== null && kept.text !== file.text
      ? kept
      : null;
  // the newest revision the page knows of, and who wrote it
  const latest = newer ?? file;
  const conflict = mode.value === "edit" && latest.revision > base.value;

  // Edit resumes a kept edit, so a keystroke never overwrites it unseen
  const startEdit = () => {
    save.touch();
    text.value = offered?.text ?? file.text;
    base.value = offered?.revision ?? file.revision;
    baseText.value = file.text;
    mode.value = "edit";
    focusTo(".docpage-editor", true);
  };

  const onSave = async () => {
    let stale = false;
    const ok = await save.act("save", async () => {
      try {
        const over = saveRevision(base.value, latest.revision, conflict);
        await saveFile(projectId, fileId, text.value, over);
      } catch (err) {
        if (!(err instanceof ApiError) || !isStale(err.status, err.message)) {
          throw err;
        }
        // the frame was missed: read the file, and the editor says who
        stale = true;
        await showLatest(fileId).catch(() => {});
      }
    });
    if (!ok || stale) return;
    dropDraft(scope);
    mode.value = "read";
    focusTo(EDIT_BUTTON);
  };

  const onRename = async () => {
    const name = path.value.trim();
    if (!pathReady(name) || name === file.name) return;
    const ok = await save.act("rename", () =>
      renameFile(projectId, fileId, name, file.revision),
    );
    if (!ok) return;
    mode.value = "read";
    focusTo(MORE_BUTTON);
  };

  // the delete drops the page's file, which takes this view with it, so
  // the way on is taken inside the call
  const onDelete = () =>
    void save.act("delete", async () => {
      await deleteFile(projectId, fileId);
      navigate(listHref(projectId, "deleted"));
    });

  // an edit kept for this file moves to the restored one, whose page
  // offers it back
  const onRestoreFile = () =>
    void save.act("restore", async () => {
      const row = await restoreFile(projectId, fileId, file.name);
      const edit = draftOf(scope);
      if (edit !== null) {
        keepDraft({ fileId: row.id }, edit.text, row.revision);
        dropDraft(scope);
      }
      navigate(restoredHref(projectId, row.id));
    });

  const past =
    revision === null ? null : revisionView(historyOf(fileId), revision);
  // what a Restore did, said on the file until another write moves it
  const restored = useSignal<{
    from: number;
    replaced: number;
    revision: number;
  } | null>(null);
  const onRestoreRevision = () =>
    void save.act("restore", async () => {
      if (past === null) return;
      const row = await saveFile(projectId, fileId, past.text, file.revision);
      restored.value = {
        from: past.revision,
        replaced: file.revision,
        revision: row.revision,
      };
      navigate(href);
    });
  const didRestore =
    restored.value !== null && restored.value.revision === file.revision;

  const problem = save.notice();
  const facts = {
    mode: mode.value,
    problem: problem !== null,
    deleted: deleted !== null,
    stale: failure !== null,
    conflict,
    newer: newer !== null,
    draft: offered !== null,
    restored: didRestore,
    unbinned: params.has("restored"),
    reading,
    revision: revision !== null,
  };
  const head: HeadProps = {
    projectId,
    file,
    now,
    busy: save.busy,
    pending: save.pending.value,
    problem,
    failure,
    openIt:
      problem?.action === "restore" && problem.status === 409
        ? (list?.files.find((row) => row.name === file.name)?.id ?? null)
        : null,
    days: list?.limits.historyDays ?? null,
    deleted,
    latest,
    offered,
    editKept: kept !== null && kept.text !== file.text,
    restored: didRestore ? restored.value : null,
    saveable: text.value !== baseText.value || conflict,
    renameReady:
      pathReady(path.value.trim()) && path.value.trim() !== file.name,
    restorable: past !== null && past.revision !== file.revision,
    more: fileActions(
      projectId,
      file.name,
      file.text,
      historyHref(projectId, fileId),
      {
        rename: () => {
          save.touch();
          path.value = file.name;
          mode.value = "rename";
          focusTo('input[name="path"]', true);
        },
        remove: () => {
          save.touch();
          mode.value = "delete";
        },
      },
    ),
    on: {
      keep: () => {
        mode.value = "read";
        focusTo(MORE_BUTTON);
      },
      remove: onDelete,
      restoreFile: onRestoreFile,
      showLatest: () => void showLatest(fileId).catch(() => {}),
      discard: () => {
        dropDraft(scope);
        focusTo(EDIT_BUTTON);
      },
      edit: startEdit,
      cancelEdit: () => {
        dropDraft(scope);
        save.touch();
        mode.value = "read";
        focusTo(EDIT_BUTTON);
      },
      save: () => void onSave(),
      cancelRename: () => {
        save.touch();
        mode.value = "read";
        focusTo(MORE_BUTTON);
      },
      restoreRevision: onRestoreRevision,
    },
  };

  let band = null;
  let body = null;
  if (mode.value === "edit") {
    band = (
      <EditorBand
        revision={base.value}
        before={baseText.value}
        text={text.value}
        cap={list?.limits.fileBytes ?? null}
      />
    );
    body = (
      <EditorBox
        name={file.name}
        text={text.value}
        onInput={(value) => {
          text.value = value;
          keepDraft(scope, value, base.value);
        }}
      />
    );
  } else if (mode.value === "rename") {
    band = (
      <form
        id="docpage-rename"
        class="docpage-band"
        ref={form}
        onSubmit={(ev) => {
          ev.preventDefault();
          void onRename();
        }}
      >
        <PathField
          value={path.value}
          save={save}
          placeholder="folder/name.md"
          onInput={(value) => {
            save.touch();
            path.value = shapePath(value);
          }}
        />
      </form>
    );
    body = (
      <p class="docpage-state">
        The file keeps its history. Agents see it under the new path from their
        next command.
      </p>
    );
  } else if (showHistory) {
    body = <History file={file} history={historyOf(fileId)} now={now} />;
  } else if (revision !== null) {
    body = (
      <Revision
        file={file}
        history={historyOf(fileId)}
        revision={revision}
        now={now}
      />
    );
  } else {
    body = <Reader file={file} href={href} line={line} now={now} />;
  }

  return (
    <Page
      split
      steps={crumbSteps(projectId, projectName, foldersOf(file.name))}
      title={baseName(file.name)}
      titleMono
      titleHref={href}
      actions={headActions(actionsKind(facts), conflict, head)}
      notice={headNotice(noticeKind(facts), head)}
    >
      <Split aside={<Facts file={file} />}>
        <section class="card docpage-card" aria-label={file.name}>
          {band}
          {body}
        </section>
      </Split>
    </Page>
  );
}
