// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The step after every emailed sign-in, in the sign-in's own card: add
// a passkey or skip. Signed in already, the app waits behind it until
// one is added or skipped.

import { useEffect } from "preact/hooks";
import { passkeys } from "../../data/passkeys.ts";
import { Icon } from "../../lib/icons.tsx";
import { Frame, Said } from "./SignIn.tsx";
import "./signin.css";

export function PasskeyStep() {
  const p = passkeys;
  useEffect(() => p.prime("add"), [p]);
  return (
    <Frame>
      <section class="card signin-card">
        <div class="signin-form">
          <div class="signin-step">
            <span class="signin-step-title">
              <Icon name="key" size={16} />
              Sign in faster next time
            </span>
            <p class="signin-hint">
              Use Face ID, Touch ID or your password manager instead of a code.
            </p>
          </div>
          <Said error={p.error.value} />
          <button
            type="button"
            class="btn btn-primary signin-add"
            disabled={p.busy.value || p.waiting("add")}
            onClick={() => void p.add()}
          >
            {p.busy.value ? "Adding" : "Add a passkey"}
          </button>
          <button
            type="button"
            class="btn-text signin-skip"
            disabled={p.busy.value}
            onClick={() => {
              p.error.value = null;
              p.step.value = false;
            }}
          >
            Skip
          </button>
        </div>
      </section>
    </Frame>
  );
}
