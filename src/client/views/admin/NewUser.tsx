// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import type { Role } from "../../../shared/words.ts";
import { address, navigate } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { createUser, emailOn, users, usersError } from "../../data/users.ts";
import { adminUserHref, USERS_HREF } from "../../lib/hrefs.ts";
import { at, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Page } from "../../ui/Page.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { fullNameProblem } from "../profile/Profile.model.ts";
import { NewCard } from "./NewCard.tsx";
import { PasswordField } from "./PasswordField.tsx";
import { UserFields, type Who } from "./UserFields.tsx";
import {
  emailProblem,
  FIRST_PASSWORD_CHOICES,
  type FirstPassword,
  firstPasswordOf,
  passwordProblem,
  ROLE_CHOICES,
  tzProblem,
  userFieldOf,
  usernameProblem,
} from "./Users.model.ts";

const STEPS = [zoneStep("Access"), { label: "Users", href: USERS_HREF }];

export function NewUser() {
  const error = usersError.value;
  return (
    <Page
      steps={STEPS}
      title="New user"
      loading={users.value === null && error === null}
      error={error}
    >
      <Form />
    </Page>
  );
}

function Form() {
  const who = useSignal<Who>({ username: "", fullName: "", email: "", tz: "" });
  const role = useSignal<Role>("member");
  const password = useSignal("");
  const first = useSignal<FirstPassword>("invite");
  const inviting = emailOn.value && first.value === "invite";
  const save = useSave(async () => {
    const from = address();
    const created = await createUser({
      username: who.value.username.trim(),
      fullName: who.value.fullName.trim(),
      email: who.value.email.trim().toLowerCase(),
      role: role.value,
      tz: who.value.tz,
      ...firstPasswordOf(emailOn.value, first.value, password.value),
    });
    if (address() === from) navigate(adminUserHref(created.username));
  }, userFieldOf);
  const w = who.value;
  const username = w.username.trim();
  const taken = (users.value ?? []).some((u) => u.username === username);
  return (
    <NewCard
      label="New user"
      create="Create user"
      cancel={USERS_HREF}
      save={save}
      ready={username !== ""}
      taken={taken ? `@${username}` : null}
      first="username"
      onSubmit={() =>
        void save.run(
          at("username", usernameProblem(w.username)) ??
            at("fullName", fullNameProblem(w.fullName)) ??
            at("email", emailProblem(w.email)) ??
            at("tz", tzProblem(w.tz)) ??
            (inviting ? null : at("password", passwordProblem(password.value))),
        )
      }
    >
      <UserFields
        who={w}
        save={save}
        onChange={(patch) => {
          who.value = { ...who.value, ...patch };
          save.touch();
        }}
      >
        {emailOn.value && (
          <div class="field">
            <span class="label">First password</span>
            <Seg
              label="First password"
              name="first"
              options={FIRST_PASSWORD_CHOICES.map((c) => ({
                ...c,
                disabled: save.busy,
              }))}
              value={first.value}
              onPick={(next) => {
                first.value = next;
                save.touch();
              }}
            />
            {inviting && (
              <span class="hint">
                Emails a link to choose a password. It works for 7 days.
              </span>
            )}
          </div>
        )}
        {!inviting && (
          <PasswordField
            id="users-new-password"
            name="password"
            label="Password"
            value={password.value}
            save={save}
            onChange={(next) => {
              password.value = next;
            }}
          />
        )}
        <div class="field">
          <span class="label">Role</span>
          <Seg
            label="Role"
            name="role"
            options={ROLE_CHOICES.map((c) => ({
              ...c,
              disabled: save.busy,
            }))}
            value={role.value}
            onPick={(next) => {
              role.value = next;
              save.touch();
            }}
          />
          <FieldError save={save} field="role" />
        </div>
      </UserFields>
    </NewCard>
  );
}
