// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A new file: the path, starting in the folder it was asked from, then
// the text; Create makes it and opens its page. What is typed is kept
// in this browser per project and folder, and comes back on return.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { navigate } from "../../../app/router.ts";
import { addFile, knowledgeOf } from "../../../data/knowledge.ts";
import {
  draftOf,
  dropDraft,
  keepDraft,
} from "../../../data/knowledge-local.ts";
import type { Failure } from "../../../lib/format.ts";
import { useFocusField, useSave } from "../../../lib/save.ts";
import { touch } from "../../../lib/touch.ts";
import { foldersOf } from "../../../lib/tree.ts";
import { Bone } from "../../../ui/Bones.tsx";
import { Page } from "../../../ui/Page.tsx";
import {
  AsideBones,
  AsideLine,
  AsideSection,
  Split,
} from "../../../ui/Split.tsx";
import { fileHref, knowledgeWords, listHref } from "../Knowledge.model.ts";
import {
  crumbSteps,
  pathFieldOf,
  pathReady,
  shapePath,
} from "./DocPage.model.ts";
import { EditorBox, SizeFact } from "./Editor.tsx";
import { ProblemNotice } from "./Notices.tsx";
import { PathField } from "./PathField.tsx";
import "./docpage.css";

export function NewFile({
  projectId,
  projectName,
  folder,
}: {
  projectId: string;
  projectName: string;
  folder: string;
}) {
  const scope = { projectId, folder };
  // the kept draft, read once as the fields' start
  const start = useRef(draftOf(scope));
  const path = useSignal(
    start.current?.name ?? (folder === "" ? "" : `${folder}/`),
  );
  const text = useSignal(start.current?.text ?? "");
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {}, pathFieldOf);
  useFocusField(save, form);
  // the page is the path field's: the caret waits after the folder, but
  // a phone's keyboard opens only on a tap
  useEffect(() => {
    if (touch()) return;
    const field =
      form.current?.querySelector<HTMLInputElement>('input[name="path"]');
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }, []);
  const list = knowledgeOf(projectId);
  const name = path.value.trim();
  const keep = () => keepDraft(scope, text.value, null, path.value);
  const onCreate = async () => {
    if (!pathReady(name)) return;
    let id: string | null = null;
    const ok = await save.act("create", async () => {
      id = (await addFile(projectId, { name, text: text.value })).id;
    });
    if (!ok || id === null) return;
    dropDraft(scope);
    navigate(fileHref(projectId, id), true);
  };
  const problem = save.notice();
  return (
    <Page
      split
      steps={crumbSteps(
        projectId,
        projectName,
        folder === "" ? [] : foldersOf(`${folder}/`),
      )}
      title="New file"
      titleMono
      actions={
        <>
          <a class="btn btn-small" href={listHref(projectId, "files")}>
            Cancel
          </a>
          <button
            type="submit"
            form="docpage-new"
            class="btn btn-small btn-primary"
            disabled={save.busy || !pathReady(name)}
          >
            {save.pending.value === "create" ? "Creating" : "Create"}
          </button>
        </>
      }
      notice={problem !== null && <ProblemNotice problem={problem} />}
    >
      <Split
        aside={
          list !== null && (
            <AsideSection label="About">
              <AsideLine label="Knowledge">
                {knowledgeWords(list.totals)}
              </AsideLine>
            </AsideSection>
          )
        }
      >
        <form
          id="docpage-new"
          class="card docpage-card"
          ref={form}
          aria-label="New file"
          onSubmit={(ev) => {
            ev.preventDefault();
            void onCreate();
          }}
        >
          <div class="docpage-band">
            <PathField
              value={path.value}
              save={save}
              placeholder="runbooks/deploy.md"
              onInput={(value) => {
                save.touch();
                path.value = shapePath(value);
                keep();
              }}
            >
              <SizeFact
                text={text.value}
                cap={list?.limits.fileBytes ?? null}
              />
            </PathField>
          </div>
          <EditorBox
            name="the new file"
            label="The new file's text"
            placeholder="The file's text"
            text={text.value}
            onInput={(value) => {
              save.touch();
              text.value = value;
              keep();
            }}
          />
        </form>
      </Split>
    </Page>
  );
}

// the page while its project loads: the head with its buttons, the
// path's band and the empty text box, beside the aside's line; Create
// waits disabled, as it does for an empty path
export function NewFileWaiting({
  projectId,
  folder,
  error,
}: {
  projectId: string;
  folder: string;
  error: Failure | null;
}) {
  return (
    <Page
      split
      steps={crumbSteps(
        projectId,
        null,
        folder === "" ? [] : foldersOf(`${folder}/`),
      )}
      title="New file"
      titleMono
      actions={
        error === null && (
          <>
            <a class="btn btn-small" href={listHref(projectId, "files")}>
              Cancel
            </a>
            <button type="button" class="btn btn-small btn-primary" disabled>
              Create
            </button>
          </>
        )
      }
      loading={error === null}
      waiting={
        <Split aside={<AsideBones label="About" lines={1} />}>
          <section
            class="card docpage-card bones-wait"
            role="status"
            aria-label="Loading the new file"
          >
            <div class="docpage-band" aria-hidden="true">
              <span class="docpage-name">
                <span class="label">Path</span>
                <Bone kind="field" at={0} class="docpage-name-box" />
              </span>
              <span class="docpage-fact docpage-fact-waiting bones-lines-line">
                <Bone kind="line" at={1} width={100} />
              </span>
            </div>
            <div
              class="docpage-editor docpage-editor-waiting"
              aria-hidden="true"
            />
          </section>
        </Split>
      }
      error={error}
    />
  );
}
