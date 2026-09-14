// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// New user: the username, the full name, the email, the role and the
// first password, typed twice, which the admin hands over. An existing
// user opens the same fields without the password; under them, a
// section resets the password, which signs the person out everywhere.
// The admin's own row has no role choice and no reset: the profile
// page is the place for those.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { UserAccount } from "../../../shared/contracts/user.ts";
import type { Role } from "../../../shared/words.ts";
import { me } from "../../data/me.ts";
import { createUser, resetPassword, updateUser } from "../../data/users.ts";
import { useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import {
  disableLock,
  emailProblem,
  fullNameProblem,
  newPasswordProblem,
  patchOf,
  ROLE_CHOICES,
  roleLock,
  usernameProblem,
} from "./Users.model.ts";
import "./users.css";
import { reason } from "../../lib/format.ts";

function RolePick({
  value,
  lock,
  busy,
  onPick,
}: {
  value: Role;
  lock: string | null;
  busy: boolean;
  onPick: (role: Role) => void;
}) {
  return (
    <div class="field users-field-wide">
      <span class="label">Role</span>
      <div class="users-roles">
        {ROLE_CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            aria-pressed={value === choice.value}
            disabled={busy || lock !== null}
            title={lock ?? undefined}
            class={`users-role${value === choice.value ? " users-role-on" : ""}`}
            onClick={() => onPick(choice.value)}
          >
            <span class="users-role-label">{choice.label}</span>
            <span class="users-role-text">{choice.text}</span>
          </button>
        ))}
      </div>
      {lock !== null && <span class="hint">{lock}</span>}
    </div>
  );
}

// Disable or Enable, at the foot's left: one call, its failure beside
// it until the next click
function Switch({ user, lock }: { user: UserAccount; lock: string | null }) {
  const busy = useSignal(false);
  const failure = useSignal<string | null>(null);
  const flip = async () => {
    busy.value = true;
    failure.value = null;
    try {
      await updateUser(user.id, { disabled: !user.disabled });
    } catch (err) {
      failure.value = reason(err);
    }
    busy.value = false;
  };
  return (
    <span class="users-switch">
      <button
        type="button"
        class={`btn${user.disabled ? "" : " btn-danger"}`}
        disabled={busy.value || lock !== null}
        title={lock ?? undefined}
        onClick={() => void flip()}
      >
        {user.disabled ? "Enable" : "Disable"}
      </button>
      <span class="hint">
        {failure.value !== null
          ? failure.value
          : (lock ??
            (user.disabled
              ? "Cannot sign in."
              : "Signs them out and blocks sign-in."))}
      </span>
    </span>
  );
}

function ResetForm({ user }: { user: UserAccount }) {
  const next = useSignal("");
  const again = useSignal("");
  const save = useSave(async () => {
    await resetPassword(user.id, { password: next.value });
    next.value = "";
    again.value = "";
  });
  const bind = (s: { value: string }) => (e: Event) => {
    s.value = (e.currentTarget as HTMLInputElement).value;
    save.touch();
  };
  const busy = save.status.value === "busy";
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(newPasswordProblem(next.value, again.value));
  };
  return (
    <form class="users-form users-reset" onSubmit={submit}>
      <div class="users-reset-head">
        <span class="label">Reset password</span>
        <span class="hint">
          Signs {user.fullName} out everywhere. Hand them the new one.
        </span>
      </div>
      <div class="users-fields">
        <label class="field">
          <span class="label">New password</span>
          <input
            name="next"
            type="password"
            autocomplete="new-password"
            disabled={busy}
            value={next.value}
            onInput={bind(next)}
          />
        </label>
        <label class="field">
          <span class="label">New password again</span>
          <input
            name="again"
            type="password"
            autocomplete="new-password"
            disabled={busy}
            value={again.value}
            onInput={bind(again)}
          />
        </label>
      </div>
      <Foot
        status={save.status.value}
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
  const username = useSignal(user?.username ?? "");
  const fullName = useSignal(user?.fullName ?? "");
  const email = useSignal(user?.email ?? "");
  const role = useSignal<Role>(user?.role ?? "member");
  const password = useSignal("");
  const again = useSignal("");
  const lock = user === null ? null : roleLock(user, meId, admins);
  const save = useSave(async () => {
    const saved = current.current;
    if (saved === null) {
      await createUser({
        username: username.value.trim(),
        fullName: fullName.value.trim(),
        email: email.value.trim().toLowerCase(),
        role: role.value,
        password: password.value,
      });
      onDone();
      return;
    }
    const body = patchOf(saved, {
      username: username.value,
      fullName: fullName.value,
      email: email.value,
      role: role.value,
    });
    if (body !== null) await updateUser(saved.id, body);
  });
  const bind = (s: { value: string }) => (e: Event) => {
    s.value = (e.currentTarget as HTMLInputElement).value;
    save.touch();
  };
  const busy = save.status.value === "busy";
  const dirty =
    user === null
      ? true
      : patchOf(user, {
          username: username.value,
          fullName: fullName.value,
          email: email.value,
          role: role.value,
        }) !== null;
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      usernameProblem(username.value) ??
        fullNameProblem(fullName.value) ??
        emailProblem(email.value) ??
        (user === null
          ? newPasswordProblem(password.value, again.value)
          : null),
    );
  };
  return (
    <div class="users-forms">
      <form class="users-form" onSubmit={submit}>
        <div class="users-fields">
          <label class="field">
            <span class="label">Username</span>
            <input
              name="username"
              autocomplete="off"
              spellcheck={false}
              placeholder="oana"
              disabled={busy}
              value={username.value}
              onInput={bind(username)}
            />
            <span class="hint">
              The sign-in name and the handle. Their personal project follows
              it.
            </span>
          </label>
          <label class="field">
            <span class="label">Full name</span>
            <input
              name="fullName"
              autocomplete="off"
              placeholder="Oana Pellea"
              disabled={busy}
              value={fullName.value}
              onInput={bind(fullName)}
            />
          </label>
          <label class="field users-field-wide">
            <span class="label">Email</span>
            <input
              name="email"
              type="email"
              autocomplete="off"
              spellcheck={false}
              placeholder="oana@example.com"
              disabled={busy}
              value={email.value}
              onInput={bind(email)}
            />
          </label>
          {(user === null || user.id !== meId) && (
            <RolePick
              value={role.value}
              lock={lock}
              busy={busy}
              onPick={(next) => {
                role.value = next;
                save.touch();
              }}
            />
          )}
          {user === null && (
            <>
              <label class="field">
                <span class="label">First password</span>
                <input
                  name="password"
                  type="password"
                  autocomplete="new-password"
                  disabled={busy}
                  value={password.value}
                  onInput={bind(password)}
                />
                <span class="hint">
                  Hand it over. They change it on their profile.
                </span>
              </label>
              <label class="field">
                <span class="label">First password again</span>
                <input
                  name="again"
                  type="password"
                  autocomplete="new-password"
                  disabled={busy}
                  value={again.value}
                  onInput={bind(again)}
                />
              </label>
            </>
          )}
        </div>
        <Foot
          status={save.status.value}
          dirty={dirty}
          label={user === null ? "New user" : "Save"}
          start={
            user === null || user.id === meId ? (
              <span />
            ) : (
              <Switch user={user} lock={disableLock(user, meId, admins)} />
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
