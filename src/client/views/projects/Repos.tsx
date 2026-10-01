// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { RepoView } from "../../../shared/api/repos.ts";
import { refWords } from "../../composer/Add.model.ts";
import { credentials, credentialsError } from "../../data/credentials.ts";
import {
  addRepo,
  changeRepo,
  deleteRepo,
  type RepoTarget,
  refreshRepo,
  repoErrorOf,
  reposOf,
  watchRepos,
} from "../../data/repos.ts";
import {
  noticeOf,
  type Save,
  useArrivalFocus,
  useFocusField,
  useSave,
} from "../../lib/save.ts";
import { countOf } from "../../lib/search.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import {
  RowsAdd,
  RowsEnd,
  RowsFailed,
  RowsLine,
  RowsList,
  RowsMeta,
  RowsNew,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Section } from "../../ui/Section.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Select } from "../../ui/Select.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { TextField } from "../admin/CredentialFields.tsx";
import {
  asksKind,
  atCap,
  CAP_LINE,
  createBody,
  credentialOptions,
  DELETE_ASK,
  draftOf,
  IGNORE_HINT,
  IGNORE_PLACEHOLDER,
  ignoreRows,
  KIND_OPTIONS,
  nameOf,
  PUBLIC_HINT,
  patchBody,
  type RepoDraft,
  repoFieldOf,
  stateWords,
  URL_PLACEHOLDER,
  urlText,
} from "./Repos.model.ts";
import "./repos.css";

// the open form: a new repository, a row's id, or none
const NEW = "new";

export function Repos({
  projectId,
  personal,
}: {
  projectId: string;
  personal: boolean;
}) {
  const open = useSignal<string | null>(null);
  useEffect(() => watchRepos(projectId), [projectId]);
  const list = reposOf(projectId);
  const full = list !== null && atCap(list);
  const add = list !== null && !full && (
    <RowsAdd
      label="Add repository"
      disabled={open.value !== null}
      onClick={() => {
        open.value = NEW;
      }}
    />
  );
  const rows = (
    <RepoRows target={{ projectId, personal }} list={list} open={open} />
  );
  if (personal) {
    return (
      <Section title="Repositories" text={PUBLIC_HINT}>
        <div class="field">
          {add && <div class="repos-head">{add}</div>}
          {list !== null || repoErrorOf(projectId) !== null ? (
            <RowsList>{rows}</RowsList>
          ) : null}
          {full && <span class="hint">{CAP_LINE}</span>}
        </div>
      </Section>
    );
  }
  return (
    <Setting
      title="Repositories"
      count={list === null ? undefined : countOf(list.length, list.length)}
      line={full ? CAP_LINE : undefined}
      list
      action={add || undefined}
    >
      {rows}
    </Setting>
  );
}

export function RepoRows({
  target,
  list,
  open,
}: {
  target: RepoTarget;
  list: RepoView[] | null;
  open: Signal<string | null>;
}) {
  // Refresh writes at once, and a refusal shows on its row
  const actions = useSave(async () => {});
  const acting = useSignal<string | null>(null);
  const error = repoErrorOf(target.projectId);
  if (list === null) {
    return error === null ? null : <RowsFailed failure={error} />;
  }
  const close = () => {
    open.value = null;
  };
  const notice = actions.notice();
  return (
    <>
      {open.value === NEW && (
        <RowsNew>
          <RepoForm target={target} row={null} onClose={close} />
        </RowsNew>
      )}
      {list.length === 0 && open.value !== NEW && (
        <RowsNote>No repositories yet.</RowsNote>
      )}
      {list.map((repo) =>
        open.value === repo.id ? (
          <RowsNew key={repo.id}>
            <RepoForm target={target} row={repo} onClose={close} />
          </RowsNew>
        ) : (
          <RepoLine
            key={repo.id}
            repo={repo}
            locked={open.value !== null || actions.busy}
            failed={
              notice !== null && acting.value === repo.id
                ? noticeOf(notice)
                : undefined
            }
            onRefresh={() => {
              acting.value = repo.id;
              void actions.act("refresh", () => refreshRepo(target, repo.id));
            }}
            onChange={() => {
              open.value = repo.id;
            }}
          />
        ),
      )}
    </>
  );
}

function RepoLine({
  repo,
  locked,
  failed,
  onRefresh,
  onChange,
}: {
  repo: RepoView;
  locked: boolean;
  failed: string | undefined;
  onRefresh: () => void;
  onChange: () => void;
}) {
  const state = stateWords(repo);
  return (
    <RowsLine flush>
      <RowsTitle
        name={repo.name}
        mono
        sub={`${urlText(repo.url)} · ${refWords(repo.ref)}`}
      />
      <RowsMeta bad={state.bad} short={state.short}>
        {state.text}
      </RowsMeta>
      <RowsEnd error={failed}>
        <button
          type="button"
          class="btn btn-small"
          disabled={locked || repo.state === "fetching"}
          onClick={onRefresh}
        >
          Refresh
        </button>
        <button
          type="button"
          class="btn btn-small"
          disabled={locked}
          onClick={onChange}
        >
          Change
        </button>
      </RowsEnd>
    </RowsLine>
  );
}

export function RepoForm({
  target,
  row,
  onClose,
}: {
  target: RepoTarget;
  row: RepoView | null;
  onClose: () => void;
}) {
  const draft = useSignal<RepoDraft>(draftOf(row));
  const asking = useSignal(false);
  const form = useRef<HTMLFormElement>(null);
  // the row the poll last brought, so a change is measured against it
  const latest = useRef(row);
  latest.current = row;
  const save = useSave(
    async () => {
      const was = latest.current;
      if (was === null) {
        await addRepo(target, createBody(draft.value, target.personal));
      } else {
        const body = patchBody(draft.value, was, target.personal);
        if (body !== null) await changeRepo(target, was.id, body);
      }
      onClose();
    },
    // a refusal of a field this form does not show goes to its notice
    (message) => {
      const field = repoFieldOf(message);
      if (field === "kind" && !asksKind(draft.value.url, target.personal)) {
        return undefined;
      }
      if (field === "credentialId" && target.personal) return undefined;
      return field;
    },
  );
  useFocusField(save, form);
  useArrivalFocus(form, "url");
  const d = draft.value;
  const set = (patch: Partial<RepoDraft>) => {
    draft.value = { ...draft.value, ...patch };
    save.touch();
  };
  const dirty =
    row === null
      ? d.url.trim() !== ""
      : patchBody(d, row, target.personal) !== null;
  const remove =
    row !== null ? (
      <AskDelete
        save={save}
        asking={asking}
        busy={save.busy}
        words={DELETE_ASK}
        wordsClass="repos-ask"
        onDelete={() => {
          void save.act("delete", async () => {
            await deleteRepo(target, row.id);
            onClose();
          });
        }}
      />
    ) : undefined;
  return (
    <form
      ref={form}
      class="repos-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
      <RepoFields draft={d} save={save} target={target} set={set} />
      {asking.value ? (
        <Foot save={save}>
          <div class="repos-delete">{remove}</div>
        </Foot>
      ) : (
        <Foot
          save={save}
          dirty={dirty}
          label={row === null ? "Add" : "Save"}
          start={remove}
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
      )}
    </form>
  );
}

// one field per line, as an edit opened by Change is laid out
export function RepoFields({
  draft: d,
  save,
  target,
  set,
}: {
  draft: RepoDraft;
  save: Save;
  target: RepoTarget;
  set: (patch: Partial<RepoDraft>) => void;
}) {
  const kindAsked = asksKind(d.url, target.personal);
  return (
    <div class="repos-fields">
      <TextField
        label="URL"
        name="url"
        value={d.url}
        placeholder={URL_PLACEHOLDER}
        required
        save={save}
        onInput={(url) => set({ url })}
      />
      <TextField
        label="Name"
        name="name"
        value={d.name}
        placeholder={nameOf(d.url)}
        hint="Its folder under /repos."
        save={save}
        onInput={(name) => set({ name })}
      />
      <TextField
        label="Branch, tag or commit"
        name="ref"
        value={d.ref}
        placeholder="Default branch"
        save={save}
        onInput={(ref) => set({ ref })}
      />
      {kindAsked && (
        <Labelled label="Host" field="kind" save={save} required>
          <Seg
            label="Host"
            name="kind"
            value={d.kind}
            invalid={save.fieldError("kind") !== null}
            options={KIND_OPTIONS.map((o) => ({ ...o, disabled: save.busy }))}
            onPick={(kind) => set({ kind })}
          />
        </Labelled>
      )}
      {!target.personal && (
        <CredentialField
          projectId={target.projectId}
          value={d.credentialId}
          save={save}
          onChange={(credentialId) => set({ credentialId })}
        />
      )}
      <label class="field">
        <span class="label">Ignore rules</span>
        <textarea
          name="ignore"
          class="repos-ignore"
          rows={ignoreRows(d.ignore)}
          spellcheck={false}
          autocomplete="off"
          placeholder={IGNORE_PLACEHOLDER}
          value={d.ignore}
          disabled={save.busy}
          aria-invalid={save.fieldError("ignore") !== null || undefined}
          onInput={(e) =>
            set({ ignore: (e.currentTarget as HTMLTextAreaElement).value })
          }
        />
        {save.fieldError("ignore") !== null ? (
          <FieldError save={save} field="ignore" />
        ) : (
          <span class="hint">{IGNORE_HINT}</span>
        )}
      </label>
    </div>
  );
}

function Labelled({
  label,
  field,
  save,
  required,
  hint,
  children,
}: {
  label: string;
  field: string;
  save: Save;
  required?: boolean;
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    <div class="field">
      <span class={`label${required ? " label-required" : ""}`}>{label}</span>
      {children}
      {save.fieldError(field) !== null ? (
        <FieldError save={save} field={field} />
      ) : (
        hint !== undefined && <span class="hint">{hint}</span>
      )}
    </div>
  );
}

function CredentialField({
  projectId,
  value,
  save,
  onChange,
}: {
  projectId: string;
  value: string;
  save: Save;
  onChange: (credentialId: string) => void;
}) {
  const options = credentialOptions(credentials.value, projectId, value);
  return (
    <Labelled
      label="Credential"
      field="credentialId"
      save={save}
      hint={
        credentialsError.value !== null
          ? `Credentials did not load: ${credentialsError.value.words}`
          : credentials.value !== null && options.length === 1
            ? "No credential is bound to this project."
            : undefined
      }
    >
      <Select
        label="Credential"
        name="credentialId"
        mono
        value={value}
        options={options}
        disabled={save.busy}
        invalid={save.fieldError("credentialId") !== null}
        onChange={onChange}
      />
    </Labelled>
  );
}
