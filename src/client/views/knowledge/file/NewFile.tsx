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
import { useFocusField, useSave } from "../../../lib/save.ts";
import { touch } from "../../../lib/touch.ts";
import { foldersOf } from "../../../lib/tree.ts";
import { Page } from "../../../ui/Page.tsx";
import { AsideLine, AsideSection, Split } from "../../../ui/Split.tsx";
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
