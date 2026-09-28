// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's admin page under Access: the crumb is the head, its own step
// the switcher to the other users; then a card per setting, each
// drafting and saving apart, nothing before Save: who they are, the
// role, the team projects they are in, a password reset, and Disable
// or Enable last, those two in UserCards.tsx. The admin's own page has
// no reset and no Disable, and its role is fixed: the profile page is
// the place for those. The aside has the last 30 days of their personal
// project alone, since a team project's turns are not theirs to answer
// for, and the account's dates.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { AdminUser } from "../../../shared/api/users.ts";
import type { Role } from "../../../shared/words.ts";
import type { Params } from "../../app/params.ts";
import { address, navigate } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { me } from "../../data/me.ts";
import { projects, projectsError } from "../../data/projects.ts";
import {
  setUserProjects,
  updateUser,
  users,
  usersError,
  userUsage,
} from "../../data/users.ts";
import { count, dayMonthYear } from "../../lib/format.ts";
import { adminUserHref, USERS_HREF } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { Finder } from "../../ui/Finder.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsNote } from "../../ui/Rows.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { fullNameProblem } from "../profile/Profile.model.ts";
import { AddProject, ProjectRows } from "./CredentialFields.tsx";
import { teamsOf } from "./Credentials.model.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { money } from "./Overview.model.ts";
import {
  type CardProps,
  locked,
  PasswordCard,
  SwitchCard,
} from "./UserCards.tsx";
import { UserFields, type Who } from "./UserFields.tsx";
import {
  adminCount,
  emailProblem,
  lastActive,
  patchOf,
  ROLE_CHOICES,
  roleLock,
  tzProblem,
  userFieldOf,
  usernameProblem,
} from "./Users.model.ts";
import "./users.css";

const STEPS = [zoneStep("Access"), { label: "Users", href: USERS_HREF }];

export function UserPage({ params }: { params: Params }) {
  const list = users.value;
  // a rename lands in the list before the address follows it: the row
  // shown last, found by id, keeps the cards and their drafts meanwhile
  const shown = useRef<AdminUser | null>(null);
  const renamed = list?.find(
    (u) => u.id === shown.current?.id && u.username !== shown.current.username,
  );
  const named = list?.find((u) => u.username === params.username) ?? null;
  const user = named ?? renamed ?? null;
  if (named !== null) shown.current = named;
  const error = usersError.value;
  return (
    <Page
      steps={STEPS}
      title={`@${params.username}`}
      titleMono
      menu={user !== null ? <Switcher user={user} /> : undefined}
      split
      loading={list === null && error === null}
      empty={
        list !== null && user === null ? "No user by that name." : undefined
      }
      // a failed read after a save keeps the list it had: the card that
      // saved says what went wrong, as setUserProjects and resetPassword
      // throw it
      error={list === null ? error : null}
    >
      {user !== null && (
        <Split aside={<Aside user={user} />}>
          <Body key={user.id} user={user} />
        </Split>
      )}
    </Page>
  );
}

// the crumb's own step: the other users by handle
function Switcher({ user }: { user: AdminUser }) {
  const list = users.value ?? [];
  if (list.length < 2) {
    return <span class="page-crumb-on page-crumb-path">@{user.username}</span>;
  }
  return (
    <Finder
      label="Users"
      triggerClass="page-pill"
      title={`@${user.username}`}
      trigger={
        <>
          <span class="cut">@{user.username}</span>
          <Icon name="chevron" size={14} class="page-pill-chevron" />
        </>
      }
      options={list.map((u) => ({
        value: u.id,
        label: `@${u.username}`,
        href: adminUserHref(u.username),
      }))}
      value={user.id}
      mono
      wide
      placeholder="Find a user"
      none="No user matches"
    />
  );
}

function Body({ user }: { user: AdminUser }) {
  const self = me.value?.id === user.id;
  // one card saves at a time, so a slower answer never puts back what
  // a later save changed
  const saving = useSignal(false);
  return (
    <div class="users-page">
      <ProfileCard user={user} saving={saving} />
      <RoleCard user={user} saving={saving} />
      <ProjectsCard user={user} saving={saving} />
      {!self && <PasswordCard user={user} saving={saving} />}
      {!self && <SwitchCard user={user} saving={saving} />}
    </div>
  );
}

// the row as a save reads it, so a save of another card in between is
// not undone
function useLatest(user: AdminUser) {
  const latest = useRef(user);
  latest.current = user;
  return latest;
}

const whoOf = (user: AdminUser): Who => ({
  username: user.username,
  fullName: user.fullName,
  email: user.email,
  tz: user.tz,
});

function ProfileCard({ user, saving }: CardProps) {
  const latest = useLatest(user);
  // only the fields edited, so a save elsewhere, or the user's own
  // change of another field, shows through and is never sent back
  const drafted = useSignal<Partial<Who> | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const who = { ...whoOf(user), ...drafted.value };
  const body = (row: AdminUser, w: Who) =>
    patchOf(row, { ...w, role: row.role });
  const save = useSave(async () => {
    const row = latest.current;
    const patch = body(row, { ...whoOf(row), ...drafted.value });
    if (patch !== null) {
      const from = address();
      const saved = await locked(saving, () => updateUser(row.id, patch));
      // the address names the old handle, which no row has now
      if (saved.username !== row.username && address() === from) {
        navigate(adminUserHref(saved.username), true);
      }
    }
    drafted.value = null;
  }, userFieldOf);
  useFocusField(save, form);
  const username = who.username.trim();
  const taken =
    username !== user.username &&
    (users.value ?? []).some((u) => u.username === username);
  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(
          at("username", usernameProblem(who.username)) ??
            at("fullName", fullNameProblem(who.fullName)) ??
            at("email", emailProblem(who.email)) ??
            at("tz", tzProblem(who.tz)),
        );
      }}
    >
      <Setting
        label="Profile"
        foot={
          <DraftFoot
            save={save}
            dirty={body(user, who) !== null}
            blocked={taken}
            locked={saving.value && !save.busy}
            hint={
              taken ? (
                <span class="error">@{username} is taken.</span>
              ) : undefined
            }
            onDiscard={() => {
              drafted.value = null;
            }}
          />
        }
      >
        <UserFields
          who={who}
          save={save}
          onChange={(patch) => {
            drafted.value = { ...drafted.value, ...patch };
            save.touch();
          }}
        />
      </Setting>
    </form>
  );
}

// the role in the head, and a line only when it is fixed, saying why
function RoleCard({ user, saving }: CardProps) {
  const latest = useLatest(user);
  const drafted = useSignal<Role | null>(null);
  const role = drafted.value ?? user.role;
  const lock = roleLock(
    user,
    me.value?.id ?? "",
    adminCount(users.value ?? []),
  );
  const save = useSave(async () => {
    const row = latest.current;
    if (drafted.value !== null && drafted.value !== row.role) {
      const role = drafted.value;
      await locked(saving, () => updateUser(row.id, { role }));
    }
    drafted.value = null;
  }, userFieldOf);
  const refused = save.fieldError("role");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
      <Setting
        title="Role"
        line={lock ?? undefined}
        action={
          <Seg
            label="Role"
            name="role"
            value={role}
            options={ROLE_CHOICES.map((c) => ({
              value: c.value,
              label: c.label,
              disabled: save.busy || lock !== null || saving.value,
            }))}
            onPick={(next) => {
              drafted.value = next;
              save.touch();
            }}
          />
        }
        foot={
          lock === null ? (
            <DraftFoot
              save={save}
              dirty={role !== user.role}
              locked={saving.value && !save.busy}
              hint={
                refused !== null ? (
                  <span class="error">{refused}</span>
                ) : undefined
              }
              onDiscard={() => {
                drafted.value = null;
              }}
            />
          ) : undefined
        }
      />
    </form>
  );
}

// the team projects they are in, each with a remove, and Add project
// over the others, as a credential's Projects card
function ProjectsCard({ user, saving }: CardProps) {
  const latest = useLatest(user);
  const drafted = useSignal<string[] | null>(null);
  const ids = drafted.value ?? user.projectIds;
  const loaded = projects.value !== null;
  const teams = teamsOf(projects.value ?? [], null);
  const save = useSave(async () => {
    if (drafted.value !== null) {
      const ids = drafted.value;
      await locked(saving, () => setUserProjects(latest.current, ids));
    }
    drafted.value = null;
  });
  const set = (projectIds: string[]) => {
    drafted.value = projectIds;
    save.touch();
  };
  const dirty =
    ids.length !== user.projectIds.length ||
    ids.some((id) => !user.projectIds.includes(id));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
      <Setting
        title="Projects"
        count={String(ids.length)}
        list
        action={
          loaded && (
            <AddProject
              teams={teams}
              value={ids}
              disabled={save.busy || saving.value}
              onChange={set}
            />
          )
        }
        foot={
          <DraftFoot
            save={save}
            dirty={dirty}
            locked={saving.value && !save.busy}
            onDiscard={() => {
              drafted.value = null;
            }}
          />
        }
      >
        {!loaded ? (
          <RowsNote>
            {projectsError.value !== null ? "Did not load." : "Loading"}
          </RowsNote>
        ) : ids.length === 0 ? (
          <RowsNote>No projects yet.</RowsNote>
        ) : (
          <ProjectRows teams={teams} value={ids} save={save} onChange={set} />
        )}
      </Setting>
    </form>
  );
}

function Aside({ user }: { user: AdminUser }) {
  const now = useNow(60_000);
  const known = user.id in userUsage.value;
  const usage = userUsage.value[user.id] ?? null;
  return (
    <>
      <AsideSection label="Personal, last 30 days">
        {!known ? (
          <p class="split-empty">Loading</p>
        ) : usage === null ? (
          <p class="split-empty">Did not load.</p>
        ) : (
          <>
            <AsideLine label="Turns">{count(usage.sends)}</AsideLine>
            <AsideLine label="Tokens">{count(usage.tokens)}</AsideLine>
            <AsideLine label="Cost">
              {usage.cost === null ? "not priced" : money(usage.cost)}
            </AsideLine>
          </>
        )}
      </AsideSection>
      <AsideSection label="Account">
        <AsideLine label="Last active">{lastActive(user, now)}</AsideLine>
        <AsideLine label="Created">{dayMonthYear(user.createdAt)}</AsideLine>
      </AsideSection>
    </>
  );
}
