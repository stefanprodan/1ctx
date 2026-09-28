// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
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
import { dayMonthYear } from "../../lib/format.ts";
import { adminUserHref, USERS_HREF } from "../../lib/hrefs.ts";
import { sameIds } from "../../lib/ids.ts";
import { useNow } from "../../lib/now.ts";
import { at, useSave } from "../../lib/save.ts";
import { countOf } from "../../lib/search.ts";
import { Page, PageSwitcher } from "../../ui/Page.tsx";
import { RowsNote } from "../../ui/Rows.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Setting, SettingForm, SettingStack } from "../../ui/Setting.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { fullNameProblem } from "../profile/Profile.model.ts";
import { SpendLines, UsageSection } from "./AdminAside.tsx";
import { AddProject, ProjectRows } from "./CredentialFields.tsx";
import { teamsOf } from "./Credentials.model.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { holding, useLatest, useShownRow } from "./drafts.ts";
import { type CardProps, PasswordCard, SwitchCard } from "./UserCards.tsx";
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

const STEPS = [zoneStep("Access"), { label: "Users", href: USERS_HREF }];

export function UserPage({ params }: { params: Params }) {
  const list = users.value;
  const { row: user } = useShownRow(
    list,
    params.username ?? "",
    (u) => u.username,
  );
  const error = usersError.value;
  return (
    <Page
      steps={STEPS}
      title={`@${params.username}`}
      titleMono
      menu={
        user !== null ? (
          <PageSwitcher
            label="Users"
            current={user.id}
            name={`@${user.username}`}
            items={(list ?? []).map((u) => ({
              id: u.id,
              label: `@${u.username}`,
              href: adminUserHref(u.username),
            }))}
            placeholder="Find a user"
            none="No user matches"
          />
        ) : undefined
      }
      split
      loading={list === null && error === null}
      empty={
        list !== null && user === null ? "No user by that name." : undefined
      }
      // a failed read after a save keeps the list: the card that saved
      // says what went wrong
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

function Body({ user }: { user: AdminUser }) {
  // the profile page is where the admin changes their own
  const self = me.value?.id === user.id;
  // one card saves at a time, so a slower answer never puts back what a
  // later save changed
  const saving = useSignal(false);
  return (
    <SettingStack>
      <ProfileCard user={user} saving={saving} />
      <RoleCard user={user} saving={saving} />
      <ProjectsCard user={user} saving={saving} />
      {!self && <PasswordCard user={user} saving={saving} />}
      {!self && <SwitchCard user={user} saving={saving} />}
    </SettingStack>
  );
}

const whoOf = (user: AdminUser): Who => ({
  username: user.username,
  fullName: user.fullName,
  email: user.email,
  tz: user.tz,
});

function ProfileCard({ user, saving }: CardProps) {
  const latest = useLatest(user);
  // only the fields edited, so the user's own change of another field
  // shows through and is never sent back
  const drafted = useSignal<Partial<Who> | null>(null);
  const who = { ...whoOf(user), ...drafted.value };
  const save = useSave(async () => {
    const row = latest.current;
    const patch = patchOf(row, { ...whoOf(row), ...drafted.value });
    if (patch !== null) {
      const from = address();
      const saved = await holding(saving, () => updateUser(row.id, patch));
      // the address names the old handle
      if (saved.username !== row.username && address() === from) {
        navigate(adminUserHref(saved.username), true);
      }
    }
    drafted.value = null;
  }, userFieldOf);
  const username = who.username.trim();
  const taken =
    username !== user.username &&
    (users.value ?? []).some((u) => u.username === username);
  return (
    <SettingForm
      save={save}
      check={() =>
        at("username", usernameProblem(who.username)) ??
        at("fullName", fullNameProblem(who.fullName)) ??
        at("email", emailProblem(who.email)) ??
        at("tz", tzProblem(who.tz))
      }
    >
      <Setting
        label="Profile"
        foot={
          <DraftFoot
            save={save}
            dirty={patchOf(user, who) !== null}
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
    </SettingForm>
  );
}

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
    const next = drafted.value;
    if (next !== null && next !== row.role) {
      await holding(saving, () => updateUser(row.id, { role: next }));
    }
    drafted.value = null;
  }, userFieldOf);
  const refused = save.fieldError("role");
  return (
    <SettingForm save={save}>
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
    </SettingForm>
  );
}

function ProjectsCard({ user, saving }: CardProps) {
  const latest = useLatest(user);
  const drafted = useSignal<string[] | null>(null);
  const ids = drafted.value ?? user.projectIds;
  const loaded = projects.value !== null;
  const teams = teamsOf(projects.value ?? [], null);
  const save = useSave(async () => {
    const next = drafted.value;
    if (next !== null) {
      await holding(saving, () => setUserProjects(latest.current, next));
    }
    drafted.value = null;
  });
  const set = (projectIds: string[]) => {
    drafted.value = projectIds;
    save.touch();
  };
  return (
    <SettingForm save={save}>
      <Setting
        title="Projects"
        count={countOf(ids.length, ids.length)}
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
            dirty={!sameIds(ids, user.projectIds)}
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
    </SettingForm>
  );
}

function Aside({ user }: { user: AdminUser }) {
  const now = useNow(60_000);
  return (
    <>
      {/* a team project's turns are not theirs to answer for */}
      <UsageSection
        label="Personal, last 30 days"
        value={userUsage.valueFor(user.id)}
      >
        {(usage) => (
          <SpendLines
            label="Turns"
            count={usage.sends}
            tokens={usage.tokens}
            cost={usage.cost}
          />
        )}
      </UsageSection>
      <AsideSection label="Account">
        <AsideLine label="Last active">{lastActive(user, now)}</AsideLine>
        <AsideLine label="Created">{dayMonthYear(user.createdAt)}</AsideLine>
      </AsideSection>
    </>
  );
}
