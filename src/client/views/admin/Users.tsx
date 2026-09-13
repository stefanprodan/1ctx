// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The users: one card of rows, each the initials, the full name, the
// handle with the email and, faint, the role and since when. A row
// opens in place into its form; New user opens an empty one at the
// top. The form is UserForm.tsx.

import { useSignal } from "@preact/signals";
import type { UserAccount } from "../../../shared/contracts/user.ts";
import { me } from "../../data/me.ts";
import { users, usersError } from "../../data/users.ts";
import { initials } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Page } from "../../ui/Page.tsx";
import { UserForm } from "./UserForm.tsx";
import { adminCount, metaLine, stateLine } from "./Users.model.ts";
import "./users.css";

function UserRow({
  user,
  admins,
  open,
  onToggle,
}: {
  user: UserAccount;
  admins: number;
  open: boolean;
  onToggle: () => void;
}) {
  const self = me.value?.id === user.id;
  return (
    <div
      class={`users-item${open ? " users-item-open" : ""}${
        user.disabled ? " users-item-off" : ""
      }`}
    >
      <button
        type="button"
        class="users-row"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon
          name="chevron"
          size={14}
          class={`users-chevron${open ? " users-chevron-open" : ""}`}
        />
        <span class={`users-avatar${open ? " users-avatar-lit" : ""}`}>
          {initials(user.fullName)}
        </span>
        <span class="users-title">
          <span class="users-name">
            {user.fullName}
            {self && <span class="users-you">you</span>}
          </span>
          <span class="users-handle">{metaLine(user)}</span>
        </span>
        <span class={`users-meta${user.disabled ? " users-off" : ""}`}>
          {stateLine(user)}
        </span>
      </button>
      {open && (
        <div class="users-body">
          <UserForm user={user} admins={admins} onDone={onToggle} />
        </div>
      )}
    </div>
  );
}

export function Users() {
  const list = users.value;
  const open = useSignal<string | null>(null);
  const adding = useSignal(false);
  const error = usersError.value;
  const admins = adminCount(list ?? []);
  return (
    <Page
      crumb="Admin"
      title="Users"
      loading={list === null && error === null}
      error={error}
    >
      <div class="users">
        <section class="users-card">
          <div class="users-card-head">
            <span class="label">Users</span>
            <button
              type="button"
              class="btn users-small users-card-act"
              disabled={adding.value}
              onClick={() => {
                adding.value = true;
                open.value = null;
              }}
            >
              <Icon name="plus" size={14} />
              New user
            </button>
          </div>
          {adding.value && (
            <div class="users-item users-item-open">
              <div class="users-body users-body-new">
                <UserForm
                  user={null}
                  admins={admins}
                  onDone={() => {
                    adding.value = false;
                  }}
                />
              </div>
            </div>
          )}
          {(list ?? []).map((u) => (
            <UserRow
              key={u.id}
              user={u}
              admins={admins}
              open={open.value === u.id}
              onToggle={() => {
                open.value = open.value === u.id ? null : u.id;
                adding.value = false;
              }}
            />
          ))}
        </section>
      </div>
    </Page>
  );
}
