// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sign-in page: the logo, the line, a card with two fields. The
// server's error shows under the button as it came.

import { useSignal } from "@preact/signals";
import { navigate } from "../../app/router.ts";
import { login } from "../../data/me.ts";
import { Logo } from "../../lib/icons.tsx";
import "./login.css";

export function Login() {
  const username = useSignal("");
  const password = useSignal("");
  const error = useSignal<string | null>(null);
  const busy = useSignal(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      await login({ username: username.value, password: password.value });
      navigate("/", true);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      busy.value = false;
    }
  };

  return (
    <main class="login">
      <div class="login-brand">
        <Logo height={80} />
        <p class="login-line">One continuous context for agents.</p>
      </div>
      <form class="login-form card" onSubmit={submit}>
        <label class="field">
          <span class="label">Username</span>
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
        <label class="field">
          <span class="label">Password</span>
          <input
            name="password"
            type="password"
            autocomplete="current-password"
            value={password.value}
            onInput={(e) => {
              password.value = (e.currentTarget as HTMLInputElement).value;
            }}
          />
        </label>
        {error.value && <p class="login-error error">{error.value}</p>}
        <button type="submit" class="btn btn-primary" disabled={busy.value}>
          Sign in
        </button>
      </form>
    </main>
  );
}
