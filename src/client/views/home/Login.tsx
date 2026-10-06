// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sign-in page: the logo, the line, a card with two fields. The
// server's error shows under the button as it came. With email on, the
// field takes an email too, and a link by email resets the password or
// signs in.

import { useSignal } from "@preact/signals";
import { askLink } from "../../data/links.ts";
import { emailOn, login } from "../../data/me.ts";
import { Logo } from "../../lib/icons.tsx";
import "./login.css";
import { says } from "../../lib/format.ts";
import { type Ask, askedLine, askProblem } from "./Login.model.ts";

export function Login() {
  const username = useSignal("");
  const password = useSignal("");
  const error = useSignal<string | null>(null);
  const asked = useSignal<string | null>(null);
  const busy = useSignal(false);
  const email = emailOn.value;

  const run = async (call: () => Promise<void>) => {
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    asked.value = null;
    try {
      await call();
    } catch (err) {
      error.value = says(err);
    } finally {
      busy.value = false;
    }
  };

  const submit = (event: Event) => {
    event.preventDefault();
    // the form renders at the address that needed a user, so staying
    // there lands on it; App sends /login itself home
    void run(() =>
      login({ username: username.value, password: password.value }),
    );
  };

  const ask = (kind: Ask) => {
    const problem = askProblem(username.value);
    if (problem !== null) {
      error.value = problem;
      asked.value = null;
      return;
    }
    void run(async () => {
      await askLink(kind, username.value.trim());
      asked.value = askedLine(kind);
    });
  };

  return (
    <main class="login">
      <div class="login-brand">
        <Logo height={80} />
        <p class="login-line">One continuous context for agents.</p>
      </div>
      <form class="login-form card" onSubmit={submit}>
        <label class="field">
          <span class="label">{email ? "Username or email" : "Username"}</span>
          <input
            name="username"
            autocomplete="username"
            autocapitalize="none"
            value={username.value}
            onInput={(e) => {
              username.value = (e.currentTarget as HTMLInputElement).value;
            }}
          />
        </label>
        <div class="field">
          <label class="label" for="login-password">
            Password
          </label>
          <input
            id="login-password"
            name="password"
            type="password"
            autocomplete="current-password"
            value={password.value}
            onInput={(e) => {
              password.value = (e.currentTarget as HTMLInputElement).value;
            }}
          />
          {email && (
            <button
              type="button"
              class="btn-text login-forgot"
              disabled={busy.value}
              onClick={() => ask("forgot")}
            >
              Forgot password?
            </button>
          )}
        </div>
        {error.value && <p class="login-error error">{error.value}</p>}
        {asked.value && (
          <p class="login-note" role="status">
            {asked.value}
          </p>
        )}
        <button type="submit" class="btn btn-primary" disabled={busy.value}>
          Sign in
        </button>
        {email && (
          <button
            type="button"
            class="btn"
            disabled={busy.value}
            onClick={() => ask("link")}
          >
            Email me a sign in link
          </button>
        )}
      </form>
    </main>
  );
}
