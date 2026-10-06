// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The page an email links to: it reads the link, names the account and
// shows one button. Opening it changes nothing, since email scanners
// open every link; only the button acts. Drawn like the sign-in page,
// outside the shell, whoever is signed in.

import { useSignal } from "@preact/signals";
import type { Params } from "../../app/params.ts";
import { navigate } from "../../app/router.ts";
import { applyLink, link, linkError } from "../../data/links.ts";
import { me } from "../../data/me.ts";
import { says, sentence } from "../../lib/format.ts";
import { Logo } from "../../lib/icons.tsx";
import "./login.css";
import {
  goneLine,
  linkWords,
  newPasswordProblem,
  otherAccount,
} from "./Link.model.ts";

export function Link({ params }: { params: Params }) {
  const token = params.token ?? "";
  const held = link.value;
  const failed = linkError.value;
  return (
    <main class="login">
      <div class="login-brand">
        <Logo height={80} />
      </div>
      {failed !== null ? (
        <div class="login-form card">
          <p class="login-note" role="alert">
            {goneLine(failed.status) ?? sentence(failed.words)}
          </p>
          <a class="btn" href="/login">
            Go to sign in
          </a>
        </div>
      ) : held !== null && held.token === token ? (
        <Act
          key={token}
          token={token}
          purpose={held.value.purpose}
          username={held.value.username}
        />
      ) : null}
    </main>
  );
}

function Act({
  token,
  purpose,
  username,
}: {
  token: string;
  purpose: Parameters<typeof linkWords>[0];
  username: string;
}) {
  const password = useSignal("");
  const error = useSignal<string | null>(null);
  const busy = useSignal(false);
  const words = linkWords(purpose, username);
  const other = otherAccount(me.value?.username ?? null, username);

  const submit = async (event: Event) => {
    event.preventDefault();
    if (busy.value) return;
    const problem = words.password ? newPasswordProblem(password.value) : null;
    if (problem !== null) {
      error.value = problem;
      return;
    }
    busy.value = true;
    error.value = null;
    try {
      await applyLink(
        token,
        words.password ? { password: password.value } : {},
      );
      // App sends one who must still change their password on
      navigate("/", true);
    } catch (err) {
      error.value = says(err);
      busy.value = false;
    }
  };

  return (
    <form class="login-form card" onSubmit={submit}>
      <h1 class="login-title">{words.title}</h1>
      <p class="login-note">{words.line}</p>
      {other !== null && <p class="login-note">{other}</p>}
      {words.password && (
        <>
          {/* whose password it is, for the browser's password manager */}
          <input
            type="text"
            name="username"
            autocomplete="username"
            value={username}
            readOnly
            hidden
          />
          <label class="field">
            <span class="label">New password</span>
            <input
              name="password"
              type="password"
              autocomplete="new-password"
              value={password.value}
              onInput={(e) => {
                password.value = (e.currentTarget as HTMLInputElement).value;
              }}
            />
          </label>
        </>
      )}
      {error.value && <p class="login-error error">{error.value}</p>}
      <button type="submit" class="btn btn-primary" disabled={busy.value}>
        {busy.value ? words.busy : words.button}
      </button>
    </form>
  );
}
