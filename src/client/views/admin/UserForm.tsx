// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// New user: the username, the full name, the email, the time zone, the
// role and the password, typed twice, which the admin hands over. An
// existing user opens the same fields without the password, with
// Disable or Enable in the foot; under them, a section resets the
// password, which signs the person out everywhere. The admin's own row
// has no role choice, no switch and no reset: the profile page is the
// place for those. A refusal shows at the field it names, or in the
// foot's notice.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { UserAccount } from "../../../shared/contracts/user.ts";
import type { Role } from "../../../shared/words.ts";
import { me } from "../../data/me.ts";
import { createUser, resetPassword, updateUser } from "../../data/users.ts";
import { shapedInput } from "../../lib/names.ts";
import { at, type Save, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { ZoneSelect } from "../../ui/ZoneSelect.tsx";
import { fullNameProblem } from "../profile/Profile.model.ts";
import { Choices } from "./Choices.tsx";
import {
  disableLock,
  emailProblem,
  newPasswordFieldProblem,
  patchOf,
  ROLE_CHOICES,
  roleLock,
  tzProblem,
  userFieldOf,
  usernameProblem,
} from "./Users.model.ts";
import "./users.css";

function RolePick({
  value,
  lock,
  save,
  onPick,
}: {
  value: Role;
  lock: string | null;
  save: Save;
  onPick: (role: Role) => void;
}) {
  return (
    <div class="field pair-wide">
      <span class="label">Role</span>
      <Choices
        name="role"
        options={ROLE_CHOICES}
        value={value}
        disabled={save.busy || lock !== null}
        title={lock ?? undefined}
        onPick={onPick}
      />
      <FieldError save={save} field="role" />
      {lock !== null && <span class="hint">{lock}</span>}
    </div>
  );
}

// Disable or Enable, at the foot's left; a refusal is the form's notice
function Switch({
  user,
  lock,
  save,
}: {
  user: UserAccount;
  lock: string | null;
  save: Save;
}) {
  const action = user.disabled ? "enable" : "disable";
  const running = save.pending.value === action;
  return (
    <span class="users-switch">
      <button
        type="button"
        class={`btn${user.disabled ? "" : " btn-danger"}`}
        disabled={save.busy || lock !== null}
        title={lock ?? undefined}
        onClick={() =>
          void save.act(action, () =>
            updateUser(user.id, { disabled: !user.disabled }),
          )
        }
      >
        {user.disabled
          ? running
            ? "Enabling"
            : "Enable"
          : running
            ? "Disabling"
            : "Disable"}
      </button>
      <span class="hint">
        {lock ??
          (user.disabled
            ? "Cannot sign in."
            : "Signs them out and blocks sign-in.")}
      </span>
    </span>
  );
}

function ResetForm({ user }: { user: UserAccount }) {
  const next = useSignal("");
  const again = useSignal("");
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(
    async () => {
      await resetPassword(user.id, { password: next.value });
      next.value = "";
      again.value = "";
    },
    (message) => (message.startsWith("password") ? "next" : undefined),
  );
  useFocusField(save, form);
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      newPasswordFieldProblem(next.value, again.value, {
        next: "next",
        again: "again",
      }),
    );
  };
  return (
    <form class="users-form users-reset" ref={form} onSubmit={submit}>
      <div class="users-reset-head">
        <span class="label">Reset password</span>
        <span class="hint">
          Signs {user.fullName} out everywhere. Hand them the new one.
        </span>
      </div>
      <div class="pair">
        <label class="field">
          <span class="label label-required">New password</span>
          <input
            name="next"
            type="password"
            autocomplete="new-password"
            aria-invalid={save.fieldError("next") !== null || undefined}
            disabled={save.busy}
            value={next.value}
            onInput={save.bind(next)}
          />
          <FieldError save={save} field="next" />
        </label>
        <label class="field">
          <span class="label label-required">New password again</span>
          <input
            name="again"
            type="password"
            autocomplete="new-password"
            aria-invalid={save.fieldError("again") !== null || undefined}
            disabled={save.busy}
            value={again.value}
            onInput={save.bind(again)}
          />
          <FieldError save={save} field="again" />
        </label>
      </div>
      <Foot
        save={save}
        dirty={next.value !== "" && again.value !== ""}
        label="Reset password"
      />
    </form>
  );
}

export function UserForm({
  user,
  admins,
  onDone,
}: {
  // null for a new user
  user: UserAccount | null;
  // how many admins there are, for the last admin's lock
  admins: number;
  onDone: () => void;
}) {
  const meId = me.value?.id ?? "";
  const current = useRef(user);
  current.current = user;
  const form = useRef<HTMLFormElement>(null);
  const username = useSignal(user?.username ?? "");
  const fullName = useSignal(user?.fullName ?? "");
  const email = useSignal(user?.email ?? "");
  const role = useSignal<Role>(user?.role ?? "member");
  const tz = useSignal(user?.tz ?? "");
  const password = useSignal("");
  const again = useSignal("");
  const lock = user === null ? null : roleLock(user, meId, admins);
  const fields = () => ({
    username: username.value,
    fullName: fullName.value,
    email: email.value,
    role: role.value,
    tz: tz.value,
  });
  const save = useSave(async () => {
    const saved = current.current;
    if (saved === null) {
      await createUser({
        username: username.value.trim(),
        fullName: fullName.value.trim(),
        email: email.value.trim().toLowerCase(),
        role: role.value,
        tz: tz.value,
        password: password.value,
      });
      onDone();
      return;
    }
    const body = patchOf(saved, fields());
    if (body !== null) await updateUser(saved.id, body);
  }, userFieldOf);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const busy = save.busy;
  const dirty = user === null ? true : patchOf(user, fields()) !== null;
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      at("username", usernameProblem(username.value)) ??
        at("fullName", fullNameProblem(fullName.value)) ??
        at("email", emailProblem(email.value)) ??
        at("tz", tzProblem(tz.value)) ??
        (user === null
          ? newPasswordFieldProblem(password.value, again.value, {
              next: "password",
              again: "again",
            })
          : null),
    );
  };
  return (
    <div class="users-forms">
      <form class="users-form" ref={form} onSubmit={submit}>
        <div class="pair">
          <label class="field">
            <span class="label label-required">Username</span>
            <input
              name="username"
              aria-required="true"
              aria-invalid={invalid("username") || undefined}
              autocomplete="off"
              spellcheck={false}
              disabled={busy}
              value={username.value}
              onInput={(e) => {
                username.value = shapedInput(e);
                save.touch();
              }}
            />
            <FieldError save={save} field="username" />
          </label>
          <label class="field">
            <span class="label label-required">Full name</span>
            <input
              name="fullName"
              aria-required="true"
              aria-invalid={invalid("fullName") || undefined}
              autocomplete="off"
              disabled={busy}
              value={fullName.value}
              onInput={save.bind(fullName)}
            />
            <FieldError save={save} field="fullName" />
          </label>
          <label class="field">
            <span class="label label-required">Email</span>
            <input
              name="email"
              aria-required="true"
              aria-invalid={invalid("email") || undefined}
              type="email"
              autocomplete="off"
              spellcheck={false}
              disabled={busy}
              value={email.value}
              onInput={save.bind(email)}
            />
            <FieldError save={save} field="email" />
          </label>
          <div class="field">
            <span class="label label-required">Time zone</span>
            <ZoneSelect
              name="tz"
              value={tz.value}
              invalid={invalid("tz")}
              disabled={busy}
              placeholder="Pick a zone"
              onChange={(next) => {
                tz.value = next;
                save.touch();
              }}
            />
            <FieldError save={save} field="tz" />
          </div>
          {(user === null || user.id !== meId) && (
            <RolePick
              value={role.value}
              lock={lock}
              save={save}
              onPick={(next) => {
                role.value = next;
                save.touch();
              }}
            />
          )}
          {user === null && (
            <>
              <label class="field">
                <span class="label label-required">Password</span>
                <input
                  name="password"
                  type="password"
                  autocomplete="new-password"
                  aria-invalid={invalid("password") || undefined}
                  disabled={busy}
                  value={password.value}
                  onInput={save.bind(password)}
                />
                {invalid("password") ? (
                  <FieldError save={save} field="password" />
                ) : (
                  <span class="hint">
                    Hand it over. They change it on their profile.
                  </span>
                )}
              </label>
              <label class="field">
                <span class="label label-required">Password again</span>
                <input
                  name="again"
                  type="password"
                  autocomplete="new-password"
                  aria-invalid={invalid("again") || undefined}
                  disabled={busy}
                  value={again.value}
                  onInput={save.bind(again)}
                />
                <FieldError save={save} field="again" />
              </label>
            </>
          )}
        </div>
        <Foot
          save={save}
          dirty={dirty}
          label={user === null ? "New user" : "Save"}
          start={
            user === null || user.id === meId ? (
              <span />
            ) : (
              <Switch
                user={user}
                lock={disableLock(user, meId, admins)}
                save={save}
              />
            )
          }
          before={
            <button type="button" class="btn" onClick={onDone}>
              {user === null ? "Cancel" : "Close"}
            </button>
          }
        />
      </form>
      {user !== null && user.id !== meId && <ResetForm user={user} />}
    </div>
  );
}
