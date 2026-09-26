// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A team project in place: the name and the description, the members
// with the picker as the list's last line, and one foot for the whole
// row. The foot saves the two fields; a member is added or removed at
// once. Every refusal of the row, a member's included, shows at the
// field it names or in the foot's notice.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import type { UserAccount } from "../../../shared/contracts/user.ts";
import {
  createProject,
  deleteProject,
  removeProjectMember,
  updateProject,
} from "../../data/admin-projects.ts";
import { initials } from "../../lib/format.ts";
import { nameProblem } from "../../lib/names.ts";
import { at, type Save, useFocusField, useSave } from "../../lib/save.ts";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import {
  RowsAvatar,
  RowsEnd,
  RowsLine,
  RowsList,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { DescriptionField, NameField } from "../projects/ProjectFields.tsx";
import { deleteLabel, projectFieldOf } from "./AdminProjects.model.ts";
import { MemberPicker } from "./MemberPicker.tsx";
import "./admin-projects.css";

function MemberRow({
  project,
  userId,
  fullName,
  username,
  save,
}: {
  project: ProjectDetail;
  userId: string;
  fullName: string;
  username: string;
  save: Save;
}) {
  const action = `remove @${username}`;
  return (
    <RowsLine flush>
      <RowsAvatar>{initials(fullName)}</RowsAvatar>
      <RowsTitle name={fullName} sub={`@${username}`} />
      <RowsEnd>
        <button
          type="button"
          class="btn btn-small"
          disabled={save.busy}
          onClick={() =>
            void save.act(action, () => removeProjectMember(project.id, userId))
          }
        >
          {save.pending.value === action ? "Removing" : "Remove"}
        </button>
      </RowsEnd>
    </RowsLine>
  );
}

export function ProjectForm({
  project,
  users,
  onDone,
}: {
  project: ProjectDetail | null;
  users: UserAccount[];
  onDone: () => void;
}) {
  const name = useSignal(project?.name ?? "");
  const description = useSignal(project?.description ?? "");
  const asking = useSignal(false);
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    const body = {
      name: name.value.trim(),
      description: description.value.trim(),
    };
    if (project === null) {
      await createProject(body);
      onDone();
    } else await updateProject(project.id, body);
  }, projectFieldOf);
  useFocusField(save, form);
  const remove = async () => {
    if (await save.act("delete", () => deleteProject(project!.id))) onDone();
  };
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(at("name", nameProblem(name.value)));
  };
  const busy = save.busy;
  const dirty =
    project === null ||
    name.value.trim() !== project.name ||
    description.value.trim() !== project.description;
  return (
    <form class="admin-projects-form" ref={form} onSubmit={submit}>
      <NameField
        class="admin-projects-name-field"
        disabled={busy}
        error={save.fieldError("name")}
        value={name.value}
        onInput={(value) => {
          name.value = value;
          save.touch();
        }}
      />
      <DescriptionField
        class="admin-projects-description-field"
        placeholder="What agents should know about this project"
        disabled={busy}
        error={save.fieldError("description")}
        value={description.value}
        onInput={(value) => {
          description.value = value;
          save.touch();
        }}
      />
      {project !== null && (
        <section class="field">
          <span class="label">Members</span>
          <RowsList>
            {project.members.length === 0 ? (
              <RowsNote>No members yet.</RowsNote>
            ) : (
              project.members.map((member) => (
                <MemberRow
                  key={member.id}
                  project={project}
                  userId={member.id}
                  fullName={member.fullName}
                  username={member.username}
                  save={save}
                />
              ))
            )}
            <MemberPicker project={project} users={users} save={save} />
          </RowsList>
        </section>
      )}
      <div class={project === null ? undefined : "admin-projects-foot"}>
        <Foot
          save={save}
          dirty={dirty}
          label={project === null ? "New project" : "Save"}
          start={
            project === null ? (
              <span />
            ) : (
              <AskDelete
                save={save}
                asking={asking}
                busy={busy}
                label={deleteLabel(project.chats)}
                onDelete={() => void remove()}
              />
            )
          }
          before={
            <button type="button" class="btn" disabled={busy} onClick={onDone}>
              {project === null ? "Cancel" : "Close"}
            </button>
          }
        />
      </div>
    </form>
  );
}
