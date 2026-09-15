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
import { matches } from "../../lib/search.ts";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAdd,
  RowsAvatar,
  RowsCard,
  RowsMeta,
  RowsNew,
  RowsNote,
  RowsOpen,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
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
    <RowsOpen
      open={open}
      onToggle={onToggle}
      off={user.disabled}
      head={
        <>
          <RowsAvatar lit={open}>{initials(user.fullName)}</RowsAvatar>
          <RowsTitle
            name={
              <>
                {user.fullName}
                {self && <span class="users-you">you</span>}
              </>
            }
            sub={metaLine(user)}
          />
          <RowsMeta bad={user.disabled}>{stateLine(user)}</RowsMeta>
        </>
      }
    >
      <UserForm user={user} admins={admins} onDone={onToggle} />
    </RowsOpen>
  );
}

export function Users() {
  const list = users.value;
  const open = useSignal<string | null>(null);
  const adding = useSignal(false);
  const error = usersError.value;
  const admins = adminCount(list ?? []);
  const q = useSignal("");
  const shown = (list ?? []).filter((u) =>
    matches(q.value, [u.username, u.fullName, u.email]),
  );
  return (
    <Page
      crumb="Admin"
      title="Users"
      loading={list === null && error === null}
      error={error}
    >
      <Rows>
        <RowsCard
          label="Users"
          search={
            <Search
              value={q.value}
              onChange={(next) => {
                q.value = next;
              }}
              placeholder="Search users"
            />
          }
          action={
            <RowsAdd
              label="New user"
              disabled={adding.value}
              onClick={() => {
                adding.value = true;
                open.value = null;
              }}
            />
          }
        >
          {adding.value && (
            <RowsNew>
              <UserForm
                user={null}
                admins={admins}
                onDone={() => {
                  adding.value = false;
                }}
              />
            </RowsNew>
          )}
          {q.value.trim() !== "" && shown.length === 0 && (
            <RowsNote>No users found</RowsNote>
          )}
          {shown.map((u) => (
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
        </RowsCard>
      </Rows>
    </Page>
  );
}
