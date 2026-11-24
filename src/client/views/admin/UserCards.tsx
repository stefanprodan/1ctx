// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { AdminUser } from "../../../shared/api/users.ts";
import { loadUserKeys } from "../../data/access-keys.ts";
import { me } from "../../data/me.ts";
import {
  sendInvite,
  signOutEverywhere,
  updateUser,
  users,
} from "../../data/users.ts";
import { useAction, useSave } from "../../lib/save.ts";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { holding } from "./drafts.ts";
import { adminCount, disableLock, inviteCardWords } from "./Users.model.ts";

export type CardProps = { user: AdminUser; saving: Signal<boolean> };

// asked once: it ends every login, live link, passkey and access key of
// the user
export function SignOutCard({ user, saving }: CardProps) {
  const save = useSave(async () => {});
  const asking = useSignal(false);
  return (
    <Setting
      title="Sign out everywhere"
      line={`Ends every sign-in of ${user.fullName}, their unused email links, their passkeys and their access keys.`}
      foot={
        <Foot save={save} inline>
          <AskDelete
            save={save}
            asking={asking}
            busy={save.busy || saving.value}
            ask="Sign out everywhere"
            label="Sign out"
            action="sign-out"
            going="Signing out"
            onDelete={() =>
              void save.act("sign-out", async () => {
                await holding(saving, () => signOutEverywhere(user.id));
                asking.value = false;
                // it deletes the user's access keys
                void loadUserKeys(user.id);
              })
            }
          />
        </Foot>
      }
    />
  );
}

// an invite again, until the user's first sign-in; nothing changes on
// the row until the link is used
export function InviteCard({ user, saving }: CardProps) {
  const send = useAction();
  const sent = useSignal<string | null>(null);
  const words = inviteCardWords(user);
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
              await sendInvite(user.id);
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
          : "Signs them out, blocks sign-in and deletes their passkeys and access keys.")
      }
      foot={
        <Foot save={save} inline>
          <button
            type="button"
            class={`btn${user.disabled ? "" : " btn-danger"}`}
            disabled={save.busy || lock !== null || saving.value}
            onClick={() =>
              void save.act(action, async () => {
                await holding(saving, () =>
                  updateUser(user.id, { disabled: !user.disabled }),
                );
                // a disable deletes the user's access keys
                if (action === "disable") void loadUserKeys(user.id);
              })
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
