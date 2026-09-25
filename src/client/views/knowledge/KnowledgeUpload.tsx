// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { effect, useSignal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { KnowledgeLimits } from "../../../shared/contracts/knowledge.ts";
import { loadKnowledge, uploadFile } from "../../data/knowledge.ts";
import { me } from "../../data/me.ts";
import { Icon } from "../../lib/icons.tsx";
import { useFocusField } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import {
  RowsBad,
  RowsEnd,
  RowsLine,
  RowsList,
  RowsListHead,
  RowsLog,
  RowsLogGroup,
  RowsLogLine,
  RowsLogMore,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { plural, sizeWords } from "./Knowledge.model.ts";
import { UploadState } from "./Upload.state.ts";
import {
  FOLDER_HINT,
  itemWords,
  pickedWords,
  progressWords,
  skippedLog,
  uploadTotals,
} from "./Upload.words.ts";
import "./knowledge.css";

export function KnowledgeUpload({
  projectId,
  names,
  limits,
  files,
  onDone,
}: {
  projectId: string;
  names: readonly string[];
  limits: KnowledgeLimits;
  // dropped on the empty base or chosen there, picked as it opens
  files?: readonly File[];
  onDone: () => void;
}) {
  const rules = useRef({ names, fileBytes: limits.fileBytes });
  rules.current = { names, fileBytes: limits.fileBytes };
  const ref = useRef<UploadState | null>(null);
  if (ref.current === null) {
    ref.current = new UploadState({
      upload: (file, folder, options) =>
        uploadFile(projectId, file, folder, options),
      reload: () => loadKnowledge(projectId),
      currentUser: () => me.peek()?.id ?? null,
      rules: () => rules.current,
    });
  }
  const state = ref.current;
  const form = useRef<HTMLFormElement>(null);
  const over = useSignal(false);
  const all = useSignal(false);
  useFocusField(state, form);
  useEffect(() => {
    const stopWatching = effect(() => {
      void me.value;
      state.userChanged();
    });
    return () => {
      stopWatching();
      state.dispose();
    };
  }, [state]);
  useEffect(() => {
    if (files !== undefined && files.length > 0) void state.pick(files);
  }, [state]);
  const phase = state.phase.value;
  const busy = state.busy;
  const done = phase === "done";
  const uploading = phase === "uploading";
  const picking = !done && !uploading;
  const invalid = state.fieldError("folder") !== null;
  const items = state.items.value;
  const totals = uploadTotals(items);
  const progress = progressWords(state);
  const skipped = skippedLog(items, all.value);
  const bar = (
    <div
      class={`knowledge-progress${done && !state.stopped.value ? " knowledge-progress-done" : ""}`}
    >
      <div class="knowledge-progress-head">
        <span class="knowledge-progress-words">
          <strong class="knowledge-progress-title">{progress.title}</strong>
          {progress.detail && ` · ${progress.detail}`}
          {done && progress.failed && (
            <>
              {" "}
              · <RowsBad>{progress.failed}</RowsBad>
            </>
          )}
        </span>
        <span class="knowledge-progress-total">{progress.aside}</span>
      </div>
      <div
        class="meter knowledge-progress-track"
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress.percent)}
      >
        <div
          class="meter-fill knowledge-progress-fill"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
    </div>
  );
  return (
    <form
      class="knowledge-form"
      ref={form}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => event.preventDefault()}
      onSubmit={(event) => {
        event.preventDefault();
        void state.run();
      }}
    >
      <label class="field">
        <span class="label">Folder</span>
        <input
          name="folder"
          class="knowledge-folder"
          placeholder="/"
          autocomplete="off"
          spellcheck={false}
          disabled={busy || (done && !state.folderRefused.value)}
          aria-invalid={invalid || undefined}
          value={state.folder.value}
          onInput={(e) => state.setFolder(e.currentTarget.value)}
        />
        {invalid ? (
          <FieldError save={state} field="folder" />
        ) : (
          <span class="hint">{FOLDER_HINT}</span>
        )}
      </label>
      {picking && (
        // Choose files is the keyboard way to what a drop does
        // biome-ignore lint/a11y/noStaticElementInteractions: drop target
        <div
          class={`knowledge-drop${over.value ? " knowledge-drop-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!state.busy) over.value = true;
          }}
          onDragLeave={() => {
            over.value = false;
          }}
          onDrop={(e) => {
            e.preventDefault();
            over.value = false;
            void state.pick(Array.from(e.dataTransfer?.files ?? []));
          }}
        >
          <Icon name="upload" size={20} class="knowledge-drop-icon" />
          <span class="knowledge-drop-main">Drop files or archives here</span>
          <span>Text files, .zip, .tar.gz or .tar, up to 32 MB each</span>
          <label class="btn btn-small knowledge-choose">
            Choose files
            <input
              class="knowledge-file"
              type="file"
              multiple
              disabled={busy}
              onChange={(e) => {
                void state.pick(Array.from(e.currentTarget.files ?? []));
                e.currentTarget.value = "";
              }}
            />
          </label>
        </div>
      )}
      {picking && items.length > 0 && (
        <div class="field">
          <RowsListHead
            label="To upload"
            hint={`${plural(items.length, "file")} · ${sizeWords(items.reduce((n, item) => n + item.file.size, 0))}`}
          />
          <RowsList>
            {items.map((item, i) => (
              <RowsLine key={i} flush>
                <RowsTitle
                  mono
                  name={item.file.name}
                  sub={pickedWords(item)}
                  bad={item.outcome?.type === "skipped"}
                />
                <RowsEnd>
                  <button
                    type="button"
                    class="btn btn-small"
                    disabled={busy}
                    onClick={() => state.remove(item.file)}
                  >
                    Remove
                  </button>
                </RowsEnd>
              </RowsLine>
            ))}
          </RowsList>
        </div>
      )}
      {done && bar}
      {(uploading || done) && (
        <div class="field">
          <RowsListHead
            label={done ? "Uploaded" : "Uploading"}
            hint={`${plural(totals.files, "file")}${done ? "" : ` · ${sizeWords(totals.bytes)}`}`}
          />
          <RowsLog>
            {state.ready.map((item, i) => (
              <RowsLogLine key={i} name={item.file.name} {...itemWords(item)} />
            ))}
          </RowsLog>
        </div>
      )}
      {uploading && bar}
      {done && skipped.total > 0 && (
        <div class="field">
          <RowsListHead label="Skipped" hint={skipped.total} />
          <RowsLog>
            {skipped.groups.map((group, i) => (
              <Fragment key={i}>
                <RowsLogGroup>{group.name}</RowsLogGroup>
                {group.lines.map((line, j) => (
                  <RowsLogLine key={j} {...line} />
                ))}
                {group.more && <RowsLogLine name="" note={group.more} />}
              </Fragment>
            ))}
            {!all.value && skipped.total > 10 && (
              <RowsLogMore
                onClick={() => {
                  all.value = true;
                }}
              >
                Show all {skipped.total}
              </RowsLogMore>
            )}
          </RowsLog>
        </div>
      )}
      <Foot save={state}>
        {done ? (
          <>
            <button
              type="button"
              class="btn"
              onClick={() => {
                all.value = false;
                state.reset();
              }}
            >
              Upload more
            </button>
            <button type="button" class="btn btn-primary" onClick={onDone}>
              Done
            </button>
          </>
        ) : uploading ? (
          <>
            <button type="button" class="btn" onClick={() => state.stop()}>
              Stop
            </button>
            <button type="submit" class="btn btn-primary" disabled>
              Uploading
            </button>
          </>
        ) : (
          <>
            <button type="button" class="btn" disabled={busy} onClick={onDone}>
              Cancel
            </button>
            <button
              type="submit"
              class="btn btn-primary"
              disabled={busy || !state.ready.length}
            >
              {/* a count of none says nothing: the button is off anyway */}
              {state.ready.length
                ? `Upload ${plural(state.ready.length, "file")}`
                : "Upload"}
            </button>
          </>
        )}
      </Foot>
    </form>
  );
}
