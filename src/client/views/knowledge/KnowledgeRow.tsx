// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A file of the knowledge base as a row that opens: the head is a
// button, so the links are in the body's first line, then the text as
// it is, folded to its first lines, then History with Restore on every
// past version, then Delete. What each line says is Knowledge.model.ts.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { KnowledgeFile } from "../../../shared/contracts/knowledge.ts";
import {
  fileTexts,
  fileVersions,
  loadVersions,
  readFile,
  readVersion,
  removeFile,
  replaceFile,
} from "../../data/knowledge.ts";
import { says } from "../../lib/format.ts";
import { noticeOf, useSave } from "../../lib/save.ts";
import { Fold } from "../../ui/Fold.tsx";
import {
  RowsEnd,
  RowsHandle,
  RowsLine,
  RowsList,
  RowsListHead,
  RowsMeta,
  RowsOpen,
  RowsTitle,
} from "../../ui/Rows.tsx";
import {
  type AuthorWords,
  headLine,
  plural,
  textBox,
  versionLine,
} from "./Knowledge.model.ts";
import "./knowledge.css";

// who wrote the line, as a link to their page, and the chat or the run
// it came from
export function Author({ words }: { words: AuthorWords }) {
  return (
    <>
      <a class="knowledge-link" href={words.href}>
        {words.handle ? <RowsHandle name={words.name} /> : words.name}
      </a>
      {words.where !== null && words.sessionId !== null && (
        <>
          {" "}
          <a class="knowledge-link" href={`/chat/${words.sessionId}`}>
            {words.where}
          </a>
        </>
      )}
    </>
  );
}

// the author as the head says it, where nothing may be a link
function AuthorText({ words }: { words: AuthorWords }) {
  return (
    <>
      {words.handle ? <RowsHandle name={words.name} /> : words.name}
      {words.where !== null && ` ${words.where}`}
    </>
  );
}

export function KnowledgeRow({
  projectId,
  file,
  now,
  open,
  onToggle,
}: {
  projectId: string;
  file: KnowledgeFile;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const expanded = useSignal(false);
  const failure = useSignal<string | null>(null);
  // the row stays mounted while closed, so closing it folds the text
  useEffect(() => {
    if (!open) expanded.value = false;
  }, [open]);
  const save = useSave(async () => {});
  const text = fileTexts.value[file.id];
  const versions = fileVersions.value[file.id];
  // the text and the history are read on open, once per revision, since
  // a write drops what was held of the file
  useEffect(() => {
    if (!open) return;
    failure.value = null;
    let live = true;
    const fail = (err: unknown) => {
      if (live) failure.value = says(err);
    };
    if (text === undefined) void readFile(projectId, file.id).catch(fail);
    if (versions === undefined) {
      void loadVersions(projectId, file.id).catch(fail);
    }
    return () => {
      live = false;
    };
  }, [open, text, versions, file.id]);
  const restore = (versionId: string) =>
    save.act("restore", async () => {
      const held = await readVersion(projectId, versionId);
      await replaceFile(projectId, file.id, {
        text: held,
        revision: file.revision,
      });
    });
  const head = headLine(file, now);
  const box = textBox(text ?? "", expanded.value);
  const notice = save.notice();
  const busy = save.busy;
  return (
    <RowsOpen
      open={open}
      onToggle={onToggle}
      indent="chevron"
      head={
        <>
          <RowsTitle
            name={file.name}
            mono
            sub={
              <>
                {`${head.kind} · ${head.lines} · `}
                <AuthorText words={head.author} />
                {` · ${head.when}`}
              </>
            }
          />
          <RowsMeta>{plural(file.tokens, "token")}</RowsMeta>
        </>
      }
    >
      <div class="knowledge-open">
        <div class="hint">
          Revision {file.revision} by <Author words={head.author} />
          {` · ${head.when}`}
        </div>
        {failure.value !== null ? (
          <div class="hint error">{failure.value}</div>
        ) : text === undefined ? (
          <div class="hint">Loading</div>
        ) : (
          <Fold
            cut={box.cut && !expanded.value}
            onOpen={() => {
              expanded.value = true;
            }}
            label={box.label}
            framed
          >
            <pre class="textbox">{box.text}</pre>
          </Fold>
        )}
        <RowsListHead
          label="History"
          hint={versions === undefined ? undefined : versions.length}
        />
        {versions !== undefined && (
          <RowsList>
            {versions.map((version) => {
              const line = versionLine(
                version,
                version.revision === file.revision,
                now,
              );
              return (
                <RowsLine key={version.id} flush>
                  <RowsTitle
                    name={line.label}
                    sub={
                      <>
                        {line.deleted && "deleted by "}
                        <AuthorText words={line.author} />
                        {` · ${line.when}`}
                        {line.current && " · current"}
                      </>
                    }
                  />
                  {!line.current && (
                    <RowsEnd>
                      <button
                        type="button"
                        class="btn btn-small"
                        disabled={busy}
                        onClick={() => void restore(version.id)}
                      >
                        Restore
                      </button>
                    </RowsEnd>
                  )}
                </RowsLine>
              );
            })}
          </RowsList>
        )}
        <div class="knowledge-actions">
          <button
            type="button"
            class="btn btn-small btn-danger"
            disabled={busy}
            onClick={() => {
              void save.act("delete", () => removeFile(projectId, file.id));
            }}
          >
            {save.pending.value === "delete" ? "Deleting" : "Delete"}
          </button>
          {notice !== null && (
            <span class="hint error" role="alert">
              {noticeOf(notice)}
            </span>
          )}
        </div>
      </div>
    </RowsOpen>
  );
}
