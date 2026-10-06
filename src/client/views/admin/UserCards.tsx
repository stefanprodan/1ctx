// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { AdminUser } from "../../../shared/api/users.ts";
import { me } from "../../data/me.ts";
import {
  resetPassword,
  sendUserLink,
  updateUser,
  users,
} from "../../data/users.ts";
import { at, useAction, useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { Setting, SettingForm } from "../../ui/Setting.tsx";
import { holding } from "./drafts.ts";
import { PasswordField } from "./PasswordField.tsx";
import {
  adminCount,
  disableLock,
  linkCardWords,
  passwordProblem,
} from "./Users.model.ts";

export type CardProps = { user: AdminUser; saving: Signal<boolean> };

export function PasswordCard({ user, saving }: CardProps) {
  const next = useSignal("");
  const save = useSave(
    async () => {
      const password = next.value;
      await holding(saving, () => resetPassword(user.id, { password }));
      next.value = "";
    },
    (message) => (message.startsWith("password") ? "next" : undefined),
  );
  return (
    <SettingForm
      save={save}
      check={() => at("next", passwordProblem(next.value))}
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
    </SettingForm>
  );
}

// with email on the admin sends a link and never holds the password;
// nothing changes on the row until the link is used
export function LinkCard({ user, saving }: CardProps) {
  const send = useAction();
  const sent = useSignal<string | null>(null);
  const words = linkCardWords(user);
  const failed = send.failure.value;
  return (
    <Setting
      title={words.title}
      line={words.line}
      action={
        <button
          type="button"
          class="btn btn-small"
          disabled={send.busy.value || saving.value || user.disabled}
          onClick={() =>
            void send.run(async () => {
              sent.value = null;
              await sendUserLink(user.id, words.kind);
              sent.value = words.sent;
            })
          }
        >
          {send.busy.value ? "Sending" : words.button}
        </button>
      }
    >
      {(sent.value !== null || failed !== null) && (
        <p
          class={`users-result${failed !== null ? " error" : ""}`}
          role="status"
        >
          {failed ?? sent.value}
        </p>
      )}
    </Setting>
  );
}

// no ask before Disable, as it is undone as easily
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
                holding(saving, () =>
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
