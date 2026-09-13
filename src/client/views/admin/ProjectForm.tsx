// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A team project in place: the name, the members with the picker as
// the list's last line, and one foot for the whole row. Only the name
// is saved by the foot; a member is added or removed at once.

import { useSignal } from "@preact/signals";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import type { UserAccount } from "../../../shared/contracts/user.ts";
import {
  createProject,
  deleteProject,
  removeProjectMember,
  renameProject,
} from "../../data/admin-projects.ts";
import { initials, reason } from "../../lib/format.ts";
import { useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { RowsAvatar } from "../../ui/Rows.tsx";
import { deleteLabel, nameProblem } from "./AdminProjects.model.ts";
import { MemberPicker } from "./MemberPicker.tsx";
import "./admin-projects.css";

function MemberRow({
  project,
  userId,
  fullName,
  username,
  disabled,
}: {
  project: ProjectDetail;
  userId: string;
  fullName: string;
  username: string;
  disabled: boolean;
}) {
  const busy = useSignal(false);
  const failure = useSignal<string | null>(null);
  const remove = async () => {
    if (disabled || busy.value) return;
    busy.value = true;
    failure.value = null;
    try {
      await removeProjectMember(project.id, userId);
    } catch (err) {
      failure.value = reason(err);
    }
    busy.value = false;
  };
  return (
    <div class="admin-projects-member">
      <RowsAvatar>{initials(fullName)}</RowsAvatar>
      <span class="admin-projects-person">
        <span class="admin-projects-person-name">{fullName}</span>
        <span class="admin-projects-person-user">@{username}</span>
      </span>
      {failure.value !== null && (
        <span class="admin-projects-note error">{failure.value}</span>
      )}
      <button
        type="button"
        class="btn btn-small"
        disabled={disabled || busy.value}
        onClick={() => void remove()}
      >
        Remove
      </button>
    </div>
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
  const asking = useSignal(false);
  const deleting = useSignal(false);
  const failure = useSignal<string | null>(null);
  const save = useSave(async () => {
    const body = { name: name.value.trim() };
    if (project === null) await createProject(body);
    else await renameProject(project.id, body);
    if (project === null) onDone();
  });
  const remove = async () => {
    if (deleting.value || save.status.value === "busy") return;
    deleting.value = true;
    failure.value = null;
    let removed = false;
    try {
      await deleteProject(project!.id);
      removed = true;
    } catch (err) {
      failure.value = reason(err);
    }
    deleting.value = false;
    if (removed) onDone();
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (deleting.value) return;
    void save.run(nameProblem(name.value));
  };
  const busy = save.status.value === "busy" || deleting.value;
  const dirty = project === null || name.value.trim() !== project.name;
  return (
    <form class="admin-projects-form" onSubmit={submit}>
      <label class="field admin-projects-name-field">
        <span class="label">Name</span>
        <input
          name="name"
          autocomplete="off"
          spellcheck={false}
          placeholder="platform"
          disabled={busy}
          value={name.value}
          onInput={(event) => {
            name.value = (event.currentTarget as HTMLInputElement).value;
            save.touch();
          }}
        />
        <span class="hint">Lowercase letters, digits and dashes.</span>
      </label>
      {project !== null && (
        <section class="admin-projects-members">
          <span class="label">Members</span>
          <div class="admin-projects-list">
            {project.members.length === 0 ? (
              <p class="admin-projects-note">No members yet.</p>
            ) : (
              project.members.map((member) => (
                <MemberRow
                  key={member.id}
                  project={project}
                  userId={member.id}
                  fullName={member.fullName}
                  username={member.username}
                  disabled={busy}
                />
              ))
            )}
            <MemberPicker project={project} users={users} disabled={busy} />
          </div>
        </section>
      )}
      <div class={project === null ? undefined : "admin-projects-foot"}>
        <Foot
          status={deleting.value ? "busy" : save.status.value}
          dirty={dirty}
          label={project === null ? "New project" : "Save"}
          start={
            project === null ? (
              <span />
            ) : asking.value ? (
              <>
                <button
                  type="button"
                  class="btn btn-danger"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {deleting.value ? "Deleting" : deleteLabel(project.chats)}
                </button>
                <button
                  type="button"
                  class="btn"
                  disabled={busy}
                  onClick={() => {
                    asking.value = false;
                    failure.value = null;
                  }}
                >
                  Keep
                </button>
                {failure.value !== null && (
                  <span class="admin-projects-note error">{failure.value}</span>
                )}
              </>
            ) : (
              <button
                type="button"
                class="btn"
                disabled={busy}
                onClick={() => {
                  asking.value = true;
                }}
              >
                Delete
              </button>
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
