// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The user page's cards about signing in: Reset password, and Disable
// or Enable, with the page's lock every card saves under.

import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { AdminUser } from "../../../shared/api/users.ts";
import { me } from "../../data/me.ts";
import { resetPassword, updateUser, users } from "../../data/users.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { PasswordField } from "./PasswordField.tsx";
import { adminCount, disableLock, passwordProblem } from "./Users.model.ts";

export type CardProps = { user: AdminUser; saving: Signal<boolean> };

// a card's call under the page's lock
export async function locked<T>(
  saving: Signal<boolean>,
  call: () => Promise<T>,
): Promise<T> {
  saving.value = true;
  try {
    return await call();
  } finally {
    saving.value = false;
  }
}

export function PasswordCard({ user, saving }: CardProps) {
  const next = useSignal("");
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(
    async () => {
      const password = next.value;
      await locked(saving, () => resetPassword(user.id, { password }));
      next.value = "";
    },
    (message) => (message.startsWith("password") ? "next" : undefined),
  );
  useFocusField(save, form);
  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(at("next", passwordProblem(next.value)));
      }}
    >
      <Setting
        title="Reset password"
        line={`Signs ${user.fullName} out everywhere. Hand them the new one.`}
        foot={
          <Foot
            save={save}
            dirty={next.value !== "" && !saving.value}
            label="Reset password"
            inline
          />
        }
      >
        {/* whose password it is, for the browser's password manager */}
        <input
          type="text"
          name="username"
          autocomplete="username"
          value={user.username}
          readOnly
          hidden
        />
        <div class="pair">
          <PasswordField
            id="users-reset-password"
            name="next"
            label="New password"
            value={next.value}
            save={save}
            onChange={(value) => {
              next.value = value;
            }}
          />
        </div>
      </Setting>
    </form>
  );
}

// Disable in the failed colour while they can sign in, Enable once they
// cannot; either takes effect on the click, as it is undone as easily
export function SwitchCard({ user, saving }: CardProps) {
  const save = useSave(async () => {});
  const lock = disableLock(
    user,
    me.value?.id ?? "",
    adminCount(users.value ?? []),
  );
  const action = user.disabled ? "enable" : "disable";
  const running = save.pending.value === action;
  // a flip that landed clears the last refusal
  useEffect(() => save.touch(), [user.disabled]);
  return (
    <Setting
      danger={!user.disabled}
      title={
        user.disabled ? `Enable @${user.username}` : `Disable @${user.username}`
      }
      line={
        lock ??
        (user.disabled
          ? "They cannot sign in."
          : "Signs them out and blocks sign-in.")
      }
      foot={
        <Foot save={save} inline>
          <button
            type="button"
            class={`btn${user.disabled ? "" : " btn-danger"}`}
            disabled={save.busy || lock !== null || saving.value}
            onClick={() =>
              void save.act(action, () =>
                locked(saving, () =>
                  updateUser(user.id, { disabled: !user.disabled }),
                ),
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
        </Foot>
      }
    />
  );
}
