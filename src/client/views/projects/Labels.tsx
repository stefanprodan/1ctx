// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's labels on its Settings tab, written by every user who sees
// the project. Each write answers the project, so the tab redraws from
// the detail.

import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { ProjectLabel } from "../../../shared/contracts/label.ts";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import { addLabel, changeLabel, deleteLabel } from "../../data/projects.ts";
import { useArrivalFocus, useFocusField, useSave } from "../../lib/save.ts";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import {
  RowsAdd,
  RowsButton,
  RowsList,
  RowsNew,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Section } from "../../ui/Section.tsx";
import { TextField } from "../admin/CredentialFields.tsx";
import {
  atCap,
  CAP_LINE,
  createBody,
  DELETE_ASK,
  draftOf,
  footOf,
  LABELS_TEXT,
  LAST_LINE,
  type LabelDraft,
  labelFieldOf,
  labelNameProblem,
  type OpenLabel,
  openOf,
  patchBody,
} from "./Labels.model.ts";
import "./labels.css";

export function Labels({ project }: { project: ProjectDetail }) {
  const open = useSignal<OpenLabel>(null);
  const list = project.labels;
  const opened = openOf(open.value, list);
  const full = atCap(list);
  return (
    <Section title="Labels" text={LABELS_TEXT}>
      <div class="field">
        {!full && (
          <div class="labels-head">
            <RowsAdd
              label="Add label"
              disabled={opened !== null}
              onClick={() => {
                open.value = "new";
              }}
            />
          </div>
        )}
        <RowsList>
          <LabelRows project={project} open={open} />
        </RowsList>
        {full && <span class="hint">{CAP_LINE}</span>}
      </div>
    </Section>
  );
}

export function LabelRows({
  project,
  open,
}: {
  project: ProjectDetail;
  open: Signal<OpenLabel>;
}) {
  const list = project.labels;
  const opened = openOf(open.value, list);
  const close = () => {
    open.value = null;
  };
  return (
    <>
      {opened === "new" && (
        <RowsNew>
          <LabelForm project={project} row={null} onClose={close} />
        </RowsNew>
      )}
      {list.map((label) =>
        opened !== null && opened !== "new" && opened.id === label.id ? (
          <RowsNew key={label.id}>
            <LabelForm
              project={project}
              row={opened}
              last={list.length === 1}
              onClose={close}
            />
          </RowsNew>
        ) : (
          <LabelLine
            key={label.id}
            label={label}
            locked={opened !== null}
            onOpen={() => {
              open.value = label;
            }}
          />
        ),
      )}
    </>
  );
}

// the whole row opens its form, as a settings list of labels does
function LabelLine({
  label,
  locked,
  onOpen,
}: {
  label: ProjectLabel;
  locked: boolean;
  onOpen: () => void;
}) {
  return (
    <RowsButton edit disabled={locked} onClick={onOpen}>
      <RowsTitle
        name={label.name}
        mono
        sub={label.description === "" ? undefined : label.description}
        prose
        wrap
      />
    </RowsButton>
  );
}

function LabelForm({
  project,
  row,
  last = false,
  onClose,
}: {
  project: ProjectDetail;
  // as it was when the form opened: a change is measured against it
  row: ProjectLabel | null;
  // the project's only label, which cannot be deleted
  last?: boolean;
  onClose: () => void;
}) {
  const draft = useSignal<LabelDraft>(draftOf(row));
  const asking = useSignal(false);
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    if (row === null) {
      await addLabel(project.id, createBody(draft.value));
    } else {
      const body = patchBody(draft.value, row);
      if (body !== null) await changeLabel(project.id, row.id, body);
    }
    onClose();
  }, labelFieldOf);
  useFocusField(save, form);
  useArrivalFocus(form, "name");
  const d = draft.value;
  const set = (patch: Partial<LabelDraft>) => {
    draft.value = { ...draft.value, ...patch };
    save.touch();
  };
  const dirty =
    row === null ? d.name.trim() !== "" : patchBody(d, row) !== null;
  const foot = footOf(row, last, asking.value);
  useEffect(() => {
    if (foot === "last") asking.value = false;
  }, [foot]);
  const remove =
    row !== null && foot !== "last" ? (
      <AskDelete
        save={save}
        asking={asking}
        busy={save.busy}
        words={DELETE_ASK}
        wordsClass="labels-ask"
        onDelete={() => {
          void save.act("delete", async () => {
            await deleteLabel(project.id, row.id);
            onClose();
          });
        }}
      />
    ) : undefined;
  return (
    <form
      ref={form}
      class="labels-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(labelNameProblem(draft.value));
      }}
    >
      <div class="labels-fields">
        <TextField
          label="Name"
          name="name"
          value={d.name}
          required
          save={save}
          onInput={(name) => set({ name })}
        />
        <TextField
          label="Description"
          name="description"
          value={d.description}
          prose
          save={save}
          onInput={(description) => set({ description })}
        />
      </div>
      {foot === "asking" ? (
        <Foot save={save}>
          <div class="labels-delete">{remove}</div>
        </Foot>
      ) : (
        <Foot
          save={save}
          dirty={dirty}
          label={row === null ? "Add" : "Save"}
          start={
            foot === "last" ? <span class="hint">{LAST_LINE}</span> : remove
          }
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
