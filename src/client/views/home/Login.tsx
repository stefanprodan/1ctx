// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sign-in page: the logo, the line, a card. An admin signs in with
// their admin key; with email on, anyone asks for an emailed code by
// email and types it here. The server's error shows under the button
// as it came.

import { useSignal } from "@preact/signals";
import { askLink, sendCode } from "../../data/links.ts";
import { emailOn, login } from "../../data/me.ts";
import { Logo } from "../../lib/icons.tsx";
import "./login.css";
import { navigate } from "../../app/router.ts";
import { says } from "../../lib/format.ts";
import { ASKED_LINE, askProblem, codeProblem } from "./Login.model.ts";

export function Login() {
  const address = useSignal("");
  const code = useSignal("");
  // the address a code was asked for, which the code is sent with
  const askedFor = useSignal<string | null>(null);
  const key = useSignal("");
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
    void run(() => login({ key: key.value.trim() }));
  };

  const ask = () => {
    const problem = askProblem(address.value);
    if (problem !== null) {
      error.value = problem;
      asked.value = null;
      return;
    }
    void run(async () => {
      const email = address.value.trim().toLowerCase();
      await askLink(email);
      askedFor.value = email;
      asked.value = ASKED_LINE;
    });
  };

  const signInByCode = () => {
    const email = askedFor.value;
    const problem = codeProblem(code.value);
    if (email === null || problem !== null) {
      error.value = problem;
      return;
    }
    void run(async () => {
      navigate(await sendCode({ email, code: code.value.trim() }), true);
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
          <span class="label">Admin key</span>
          <input
            name="key"
            type="password"
            autocomplete="current-password"
            value={key.value}
            onInput={(e) => {
              key.value = (e.currentTarget as HTMLInputElement).value;
            }}
          />
        </label>
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
          <>
            <label class="field">
              <span class="label">Email</span>
              <input
                name="email"
                type="email"
                autocomplete="email"
                autocapitalize="none"
                value={address.value}
                onInput={(e) => {
                  address.value = (e.currentTarget as HTMLInputElement).value;
                }}
              />
            </label>
            <button
              type="button"
              class="btn"
              disabled={busy.value}
              onClick={ask}
            >
              Email me a code
            </button>
            {askedFor.value !== null && (
              <>
                <label class="field">
                  <span class="label">Code</span>
                  <input
                    name="code"
                    inputMode="numeric"
                    autocomplete="one-time-code"
                    maxLength={6}
                    value={code.value}
                    onInput={(e) => {
                      code.value = (e.currentTarget as HTMLInputElement).value;
                    }}
                  />
                </label>
                <button
                  type="button"
                  class="btn"
                  disabled={busy.value}
                  onClick={signInByCode}
                >
                  Sign in with code
                </button>
              </>
            )}
          </>
        )}
      </form>
    </main>
  );
}
