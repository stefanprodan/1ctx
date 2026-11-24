// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sign-in page: the lockup and one card. With email on, anyone signs
// in by a code emailed to them, typed in six boxes; a passkey signs in
// where one was added; an admin signs in with their admin key. The way
// picked is kept per browser. The dead link page's ask opens it on the
// code for the address it handed over.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef } from "preact/hooks";
import type { Params } from "../../app/params.ts";
import { navigate } from "../../app/router.ts";
import { askLink, sendCode, takeHandOver } from "../../data/links.ts";
import { confirmMe, emailOn, login } from "../../data/me.ts";
import { dropSignedIn, passkeys } from "../../data/passkeys.ts";
import { says } from "../../lib/format.ts";
import { type IconName, Mark, Wordmark } from "../../lib/icons.tsx";
import {
  type AssertionJSON,
  cancelled,
  passkeyWords,
  unknownPasskey,
} from "../../lib/passkeys.ts";
import { SplitButton, type SplitItem } from "../../ui/SplitButton.tsx";
import { CodeBoxes } from "./CodeBoxes.tsx";
import {
  codeFlow,
  DIGITS,
  holdLine,
  keepWay,
  keptWay,
  type Outcome,
  oneAtATime,
  type Step,
  sayLine,
  UNREAD,
  type Way,
  wayOf,
  waysOffered,
} from "./SignIn.model.ts";
import "./signin.css";

const WAYS: Record<Way, { label: string; icon: IconName }> = {
  email: { label: "Email code", icon: "mail" },
  passkey: { label: "Passkey", icon: "key" },
  key: { label: "Admin key", icon: "shield" },
};

// keeps its height, so nothing moves when it shows
export function Said({ error }: { error: string | null }) {
  return (
    <p class="signin-say error" role="alert">
      {error ?? ""}
    </p>
  );
}

export function Frame({ children }: { children: ComponentChildren }) {
  return (
    <main class="signin">
      <div class="signin-brand">
        <Mark size={64} />
        <div class="signin-name">
          <Wordmark height={26} />
        </div>
      </div>
      {children}
    </main>
  );
}

// opening and address: the step and the address to start on, as the
// dead link page's hand-over and a render of a later step need
export function SignIn({
  opening,
  address,
}: {
  opening?: Step;
  address?: string;
}) {
  const on = emailOn.value;
  // the first drawn takes the hand-over, once
  const handed = useMemo(() => (opening ? null : takeHandOver()), [opening]);
  const chosen = useSignal<Step>(
    opening ?? (handed !== null ? "code" : (keptWay() ?? "email")),
  );
  const support = passkeys.support.value;
  const step = wayOf(chosen.value, on, support);
  const email = useSignal(address ?? handed ?? "");
  const code = useSignal("");
  const key = useSignal("");
  const error = useSignal<string | null>(null);
  // a code refused: the boxes turn red until the next digit
  const wrong = useSignal(false);
  const busy = useSignal(false);
  const resent = useSignal(false);
  // an email on its way: the first step's button, or Send a new code
  const sending = useSignal(false);
  // the code was taken but who it is not read: Try again reads it again
  const unread = useSignal(false);
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (step === "code") codeInput.current?.focus();
  }, [step]);
  // a refused passkey is not offered again this visit
  const refused = useSignal(false);
  // the email and key fields' autofill; not mid-code, where the boxes
  // hold the user's attention
  const fill =
    support &&
    passkeys.autofill.value &&
    !refused.value &&
    (step === "email" || step === "key");
  useEffect(
    // options in hand before any tap, the menu's Passkey included; the
    // autofill primes its own
    () =>
      support && step !== "code" && !fill
        ? passkeys.prime("sign_in")
        : undefined,
    [support, step, fill],
  );
  useEffect(
    () =>
      fill
        ? passkeys.listen((answer) => {
            // its challenge is spent: a busy card holds it again on new
            // options
            if (busy.peek() || sending.peek()) passkeys.signInFailed();
            else void signInByPasskey(answer);
          })
        : undefined,
    [fill],
  );

  const flow = useMemo(
    () =>
      codeFlow({
        post: (typed, landed) =>
          sendCode(email.peek(), typed, landed, (to) => navigate(to, true)),
        read: async () => (await confirmMe()).who,
      }),
    [],
  );

  // a wrong code empties the boxes for the next try
  const land = (r: Outcome) => {
    unread.value = r.kind === "unread";
    if (r.kind === "in") return;
    busy.value = false;
    if (r.kind === "unread") {
      error.value = UNREAD;
      return;
    }
    error.value = r.error === null ? "Wrong or expired code." : says(r.error);
    wrong.value = true;
    code.value = "";
    // after the render that enables the boxes again
    setTimeout(() => codeInput.current?.focus(), 0);
  };
  const checkCode = useMemo(
    () =>
      oneAtATime(async (typed: string) => {
        busy.value = true;
        error.value = null;
        land(await flow.submit(typed));
      }),
    [flow],
  );
  const retry = useMemo(
    () =>
      oneAtATime(async () => {
        busy.value = true;
        error.value = null;
        land(await flow.retry());
      }),
    [flow],
  );
  // a new code or another email starts over
  const restart = () => {
    flow.reset();
    unread.value = false;
  };
  // the boxes were off during the read, so the focus went with them
  const again = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (unread.value && !busy.value) again.current?.focus();
  }, [unread.value, busy.value]);

  const send = async (): Promise<boolean> => {
    if (sending.value) return false;
    sending.value = true;
    try {
      await askLink(email.value);
      return true;
    } catch (err) {
      error.value = says(err);
      return false;
    } finally {
      sending.value = false;
    }
  };

  // any step change starts the code over
  const go = (to: Step) => {
    restart();
    code.value = "";
    error.value = null;
    wrong.value = false;
    chosen.value = to;
  };

  // answer: the autofill's; else the browser is asked before any await,
  // inside the tap
  async function signInByPasskey(answer?: AssertionJSON) {
    if (busy.value || sending.value) return;
    const signing = passkeys.signIn((to) => navigate(to, true), answer);
    dropSignedIn();
    busy.value = true;
    error.value = null;
    try {
      await signing;
    } catch (err) {
      const words = passkeyWords(err, false);
      if (!cancelled(err)) refused.value = true;
      // gone from the account: the way it was kept on goes with it
      if (unknownPasskey(err) && chosen.peek() === "passkey") {
        const back: Way = on ? "email" : "key";
        keepWay(back);
        go(back);
      }
      error.value = words;
    } finally {
      busy.value = false;
    }
  }

  const submitKey = async (event: Event) => {
    event.preventDefault();
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    dropSignedIn();
    try {
      // the form renders at the address that needed a user, so staying
      // there lands on it; App sends /login itself home
      await login({ key: key.value.trim() });
      key.value = "";
    } catch (err) {
      error.value = says(err);
    } finally {
      busy.value = false;
    }
  };

  const ways: SplitItem[] = waysOffered(on, support).map((way) => ({
    label: WAYS[way].label,
    icon: WAYS[way].icon,
    checked: step === way,
    run: () => {
      keepWay(way);
      go(way);
      // picking Passkey asks for it in the same tap, as iOS needs
      if (way === "passkey") void signInByPasskey();
    },
  }));
  const codeActions: SplitItem[] = [
    {
      label: "Send a new code",
      icon: "retry",
      run: async () => {
        go("code");
        resent.value = false;
        if (!(await send())) return;
        resent.value = true;
        codeInput.current?.focus();
      },
    },
    {
      label: "Use another email",
      icon: "pen",
      run: () => {
        resent.value = false;
        go("email");
      },
    },
  ];

  return (
    <Frame>
      <section class="card signin-card">
        {step === "email" && (
          <form
            class="signin-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!email.value.includes("@")) return;
              error.value = null;
              if (await send()) go("code");
            }}
          >
            <label class="field">
              <span class="label">Email</span>
              <input
                class="signin-input"
                name="email"
                type="email"
                autocomplete={fill ? "email webauthn" : "email"}
                inputmode="email"
                disabled={sending.value}
                value={email.value}
                onInput={(e) => {
                  email.value = (e.currentTarget as HTMLInputElement).value;
                }}
              />
            </label>
            <Said error={error.value} />
            <SplitButton
              disabled={sending.value || busy.value}
              working={sending.value || busy.value}
              items={ways}
              label="Ways to sign in"
            >
              {sending.value ? "Sending" : "Sign in"}
            </SplitButton>
          </form>
        )}
        {step === "passkey" && (
          <div class="signin-form">
            <p class="signin-hint">
              Use Face ID, Touch ID or your password manager.
            </p>
            <Said error={error.value} />
            <SplitButton
              disabled={
                busy.value || sending.value || passkeys.waiting("sign_in")
              }
              // a stalled fetch never keeps the user from another way
              menuDisabled={busy.value || sending.value}
              onClick={() => void signInByPasskey()}
              working={busy.value || passkeys.waiting("sign_in")}
              items={ways}
              label="Ways to sign in"
            >
              {busy.value ? "Signing in" : "Sign in"}
            </SplitButton>
          </div>
        )}
        {step === "code" && (
          <form
            class="signin-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.value.length === DIGITS) void checkCode(code.value);
            }}
          >
            <div class="field">
              <span class="label" id="signin-code-label">
                Code
              </span>
              <CodeBoxes
                value={code.value}
                first={codeInput}
                wrong={wrong.value}
                disabled={busy.value}
                onChange={(v) => {
                  code.value = v;
                  error.value = null;
                  wrong.value = false;
                  resent.value = false;
                  // the sixth digit signs in, as code pages do
                  if (v.length === DIGITS) void checkCode(v);
                }}
              />
            </div>
            {/* one line that always keeps its height, so nothing moves */}
            <p
              class={`signin-say${
                error.value && !busy.value ? " error" : " signin-say-faint"
              }`}
              role="status"
            >
              <span class="signin-say-cell signin-say-hold" aria-hidden="true">
                {holdLine(email.value)}
              </span>
              <span class="signin-say-cell">
                {sayLine({
                  checking: busy.value,
                  error: error.value,
                  resent: resent.value,
                  email: email.value,
                })}
              </span>
            </p>
            <SplitButton
              goRef={again}
              disabled={
                busy.value ||
                sending.value ||
                (!unread.value && code.value.length < DIGITS)
              }
              menuDisabled={busy.value || sending.value}
              working={busy.value || sending.value}
              onClick={unread.value ? () => void retry() : undefined}
              items={codeActions}
              label="More"
            >
              {unread.value
                ? "Try again"
                : busy.value
                  ? "Signing in"
                  : sending.value
                    ? "Sending"
                    : "Sign in"}
            </SplitButton>
          </form>
        )}
        {step === "key" && (
          <form class="signin-form" onSubmit={submitKey}>
            <label class="field">
              <span class="label">Admin key</span>
              <input
                class="signin-input"
                name="key"
                type="password"
                autocomplete={
                  fill ? "current-password webauthn" : "current-password"
                }
                value={key.value}
                onInput={(e) => {
                  key.value = (e.currentTarget as HTMLInputElement).value;
                }}
              />
            </label>
            <Said error={error.value} />
            <SplitButton
              disabled={busy.value}
              working={busy.value}
              items={ways}
              label="Ways to sign in"
            >
              Sign in
            </SplitButton>
          </form>
        )}
      </section>
    </Frame>
  );
}

// the /login route's view, which reads no params
export function SignInPage(_: { params: Params }) {
  return <SignIn />;
}
