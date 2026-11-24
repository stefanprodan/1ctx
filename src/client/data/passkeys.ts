// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Passkeys: the user's list, the add and the sign-in with one, and the
// step after an emailed sign-in. Options are fetched before the tap,
// since iOS runs create() and get() only inside it and a fetch between
// may lose it: a tap without them only fetches.

import { effect, type Signal, signal, untracked } from "@preact/signals";
import type { PasskeySignInResponse } from "../../shared/api/access.ts";
import type { Passkey, PasskeysResponse } from "../../shared/api/profile.ts";
import { query } from "../app/router.ts";
import { type Failure, failure } from "../lib/format.ts";
import {
  type AssertionJSON,
  type CreationJSON,
  fresh,
  passkeyWords,
  type RequestJSON,
  refreshIn,
  takeSignedIn,
  unknownPasskey,
} from "../lib/passkeys.ts";
import { api } from "./api.ts";
import { me, opened } from "./me.ts";
import { browserPasskeys, type PasskeyDevice } from "./passkey-device.ts";
import { signInPost } from "./sign-in.ts";

export const PASSKEYS_PATH = "/api/profile/passkeys";
export const PASSKEY_OPTIONS_PATH = "/api/profile/passkeys/options";
export const PASSKEY_SIGN_IN_PATH = "/api/login/passkey";
export const PASSKEY_SIGN_IN_OPTIONS_PATH = "/api/login/passkey/options";

// a timer's start, answering its cancel
export type Later = (ms: number, fire: () => void) => () => void;

const timer: Later = (ms, fire) => {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
};

// a failed options refresh tries again after this
const RETRY_MS = 30_000;

// a passkey's relying party is the host, whatever the port
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

type Purpose = "add" | "sign_in";
const OPTIONS: Record<Purpose, string> = {
  add: PASSKEY_OPTIONS_PATH,
  sign_in: PASSKEY_SIGN_IN_OPTIONS_PATH,
};
type Options = CreationJSON | RequestJSON;
type Primed = { json: Options; at: number; session: number };

export type PasskeysDeps = {
  call: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  // the sign-in's post, without the 401 hook, and its read of who it is
  post: (path: string, body: unknown, wrong: string) => Promise<unknown>;
  opened: () => Promise<void>;
  // one more on every sign in or out
  session: () => number;
  device: PasskeyDevice;
  now: () => number;
  later: Later;
};

export function passkeysStore(d: PasskeysDeps) {
  const { call, session, device, now, later } = d;
  const support = signal(device.supported());
  // every origin's, as answered; null until read
  const list = signal<Passkey[] | null>(null);
  // the list's read failed
  const failed = signal<Failure | null>(null);
  // a failed add, in words
  const error = signal<string | null>(null);
  const busy = signal(false);
  // no usable options and a fetch on its way: the button waits for it
  const waiting: Record<Purpose, Signal<boolean>> = {
    add: signal(false),
    sign_in: signal(false),
  };
  // the sign-in card's passkey step, after every emailed sign-in
  const step = signal(false);
  // asked once at start, so the step shows in the sign-in's own render
  let platform: Promise<boolean> | boolean = support.peek()
    ? device.platform().then(
        (v) => (platform = v),
        () => (platform = false),
      )
    : false;
  // the email and admin key fields offer passkeys in their autofill, so
  // the sign-in needs no button of its own
  const autofill = signal(false);
  if (support.peek()) {
    device.autofill().then(
      (v) => {
        autofill.value = v;
      },
      () => {},
    );
  }
  // the autofill's request starts again with each new sign-in options
  let freshSignIn: (() => void) | null = null;
  let autofillHeld: AbortController | null = null;
  const primed: Record<Purpose, Primed | null> = { add: null, sign_in: null };
  const wants: Record<Purpose, number> = { add: 0, sign_in: 0 };
  const asked: Record<Purpose, number> = { add: 0, sign_in: 0 };
  const timers: Record<Purpose, () => void> = {
    add: () => {},
    sign_in: () => {},
  };
  let load = 0;
  // one more on every sign out, so a step asked before one never shows
  let outs = 0;
  let unwatch = () => {};

  const stale = (p: Purpose) => {
    const o = primed[p];
    return (
      o === null ||
      o.session !== session() ||
      !fresh(o.at, o.json.timeout, now())
    );
  };

  const shown = () => {
    for (const p of ["add", "sign_in"] as const) {
      if (wants[p] > 0 && stale(p)) void fetchOptions(p).catch(() => {});
    }
  };

  function schedule(p: Purpose) {
    timers[p]();
    timers[p] = () => {};
    const o = primed[p];
    if (wants[p] === 0 || o === null) return;
    const refresh = () => {
      if (wants[p] > 0 && !device.hidden()) {
        // a failed refresh tries again, or the autofill would end with it
        void fetchOptions(p).catch(() => {
          timers[p] = later(RETRY_MS, refresh);
        });
      }
    };
    timers[p] = later(refreshIn(o.at, o.json.timeout, now()), refresh);
  }

  async function fetchOptions(p: Purpose): Promise<Options> {
    const mine = ++asked[p];
    const at = session();
    // the challenge's two minutes may start any time after the ask
    const sent = now();
    if (stale(p)) waiting[p].value = true;
    try {
      const json = await call<Options>(OPTIONS[p], "POST");
      if (mine === asked[p] && at === session()) {
        primed[p] = { json, at: sent, session: at };
        schedule(p);
        if (p === "sign_in") freshSignIn?.();
      }
      return json;
    } finally {
      // a sign-out bumps asked, so a session check would only strand it
      if (mine === asked[p]) waiting[p].value = false;
    }
  }

  // options in hand from when a page part showed, while still fresh
  function take(p: Purpose): Options | null {
    const o = primed[p];
    primed[p] = null;
    return o !== null &&
      o.session === session() &&
      fresh(o.at, o.json.timeout, now())
      ? o.json
      : null;
  }

  // each challenge is used once, so the next tap needs new options
  const again = (p: Purpose) => {
    if (wants[p] > 0) void fetchOptions(p).catch(() => {});
  };

  // while a passkey button shows; the release lets go
  function prime(p: Purpose): () => void {
    if (wants.add + wants.sign_in === 0) unwatch = device.onVisible(shown);
    wants[p]++;
    if (stale(p)) void fetchOptions(p).catch(() => {});
    else schedule(p);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      wants[p]--;
      if (wants[p] === 0) schedule(p);
      if (wants.add + wants.sign_in === 0) {
        unwatch();
        unwatch = () => {};
      }
    };
  }

  async function read(): Promise<void> {
    if (!support.peek()) return;
    const mine = ++load;
    const at = session();
    failed.value = null;
    try {
      const a = await call<PasskeysResponse>(PASSKEYS_PATH);
      if (mine === load && at === session()) list.value = a.passkeys;
    } catch (e) {
      if (mine === load && at === session()) failed.value = failure(e);
    }
  }

  // a tap without fresh options only fetches them; the button waits
  async function refetch(p: Purpose): Promise<void> {
    const at = session();
    error.value = null;
    try {
      await fetchOptions(p);
    } catch (e) {
      if (at === session() && p === "add") error.value = passkeyWords(e, true);
      if (p === "sign_in") throw e;
    }
  }

  async function add(): Promise<boolean> {
    if (busy.peek() || waiting.add.peek()) return false;
    const o = take("add") as CreationJSON | null;
    if (o === null) {
      await refetch("add");
      return false;
    }
    // no await before create(): iOS runs it only inside the tap
    const made = device.create(o);
    const at = session();
    busy.value = true;
    error.value = null;
    try {
      const sent = await made;
      // signed out while the browser asked: the answer is never sent
      if (at !== session()) return false;
      const item = await call<Passkey>(PASSKEYS_PATH, "POST", sent);
      if (at !== session()) return false;
      list.value = [...(list.peek() ?? []), item];
      // a list read before the add lacks it, so read again
      void read();
      step.value = false;
      return true;
    } catch (e) {
      if (at === session()) error.value = passkeyWords(e, true);
      return false;
    } finally {
      if (at === session()) {
        busy.value = false;
        again("add");
      }
    }
  }

  // a refusal throws, for the row to say
  async function remove(id: string): Promise<void> {
    const at = session();
    await call(`${PASSKEYS_PATH}/${encodeURIComponent(id)}`, "DELETE");
    // this host's: else the password manager would keep offering it
    const gone = list.peek()?.find((p) => p.id === id);
    if (gone !== undefined && sameHost(gone.origin, device.origin())) {
      device.forget(gone.credentialId);
    }
    if (at === session()) {
      load++;
      list.value = (list.peek() ?? []).filter((p) => p.id !== id);
    }
    // the add's options no longer hold it among this device's own
    again("add");
  }

  // null: no fresh options, so the tap only fetched them
  function assert(): Promise<AssertionJSON | null> {
    if (waiting.sign_in.peek()) return Promise.resolve(null);
    const o = take("sign_in") as RequestJSON | null;
    if (o === null) return refetch("sign_in").then(() => null);
    // a browser holds one request at a time: the autofill's goes first
    autofillHeld?.abort();
    autofillHeld = null;
    return device.get(o).catch((e: unknown) => {
      again("sign_in");
      throw e;
    });
  }

  // held open while the fields show; each options refresh restarts it
  function listen(answered: (a: AssertionJSON) => void): () => void {
    let done = false;
    const start = () => {
      autofillHeld?.abort();
      autofillHeld = null;
      const o = primed.sign_in;
      if (done || o === null || stale("sign_in")) return;
      const c = new AbortController();
      autofillHeld = c;
      device.get(o.json as RequestJSON, c.signal).then(
        (a) => {
          if (c.signal.aborted) return;
          // its challenge is spent: the next one waits for new options
          primed.sign_in = null;
          answered(a);
        },
        // refused: held again by the next refresh, never at once, since a
        // browser refusing every request would loop on the options
        () => {},
      );
    };
    freshSignIn = start;
    const release = prime("sign_in");
    start();
    return () => {
      done = true;
      if (freshSignIn === start) freshSignIn = null;
      autofillHeld?.abort();
      autofillHeld = null;
      release();
    };
  }

  // one https host is one server; on loopback two installs on two ports
  // share the relying party, so another's passkey must not be forgotten
  const forget = (credentialId: string) => {
    if (device.origin().startsWith("https:")) device.forget(credentialId);
  };

  // the browser is asked first, inside the tap, unless the autofill's
  // answer is given; go takes the landing, as the code's does
  async function signIn(
    go: (landing: string) => void,
    answered?: AssertionJSON,
  ): Promise<void> {
    const sent = answered ?? (await assert());
    if (sent === null) return;
    try {
      const a = (await d.post(
        PASSKEY_SIGN_IN_PATH,
        sent,
        "passkey not accepted",
      )) as Partial<PasskeySignInResponse> | null;
      if (typeof a?.landing === "string" && a.landing.startsWith("/")) {
        go(a.landing);
      }
      await d.opened();
    } catch (e) {
      if (unknownPasskey(e)) forget(sent.id);
      again("sign_in");
      throw e;
    }
  }

  // after every emailed sign-in, on a device with a platform authenticator
  async function considerStep(): Promise<void> {
    if (!support.peek()) return;
    const at = outs;
    const p = typeof platform === "boolean" ? platform : await platform;
    if (at !== outs) return;
    error.value = null;
    step.value = p;
  }

  const signedOut = () => {
    outs++;
    load++;
    asked.add++;
    asked.sign_in++;
    primed.add = null;
    primed.sign_in = null;
    waiting.add.value = false;
    waiting.sign_in.value = false;
    busy.value = false;
    list.value = null;
    failed.value = null;
    error.value = null;
    step.value = false;
  };

  return {
    support,
    autofill,
    list,
    failed,
    error,
    busy,
    // the Add and the Sign in buttons hold off while it is true
    waiting: (p: Purpose) => waiting[p].value,
    step,
    origin: () => device.origin(),
    prime,
    read,
    add,
    remove,
    assert,
    listen,
    signIn,
    // an autofill answer the busy card could not take: its challenge is
    // spent, so new options hold the autofill again
    signInFailed: () => again("sign_in"),
    considerStep,
    signedOut,
  };
}

export type PasskeysStore = ReturnType<typeof passkeysStore>;

// every change of who is signed in, so an answer for a session gone is
// dropped
let session = 0;

export const passkeys = passkeysStore({
  call: api,
  post: signInPost,
  opened,
  session: () => session,
  device: browserPasskeys(),
  now: Date.now,
  later: timer,
});

let owner: string | null = null;
effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  const was = owner;
  owner = id;
  session++;
  // a list or step of the user before never shows to the next
  if (id === null || was !== null) untracked(() => passkeys.signedOut());
});

export const loadPasskeys = (): Promise<void> => passkeys.read();

// the address the passkey step's flag rides on
export type Address = { search(): string; replace(search: string): void };

const browserAddress: Address = {
  search: () => query.peek(),
  replace: (search) => {
    history.replaceState(
      history.state,
      "",
      location.pathname + search + location.hash,
    );
    query.value = search;
  },
};

// a key or passkey sign-in asks no step: drop a stale flag
export function dropSignedIn(address: Address = browserAddress): void {
  const t = takeSignedIn(address.search());
  if (t.found) address.replace(t.search);
}

// an emailed sign-in lands with the flag: once signed in, it is taken
// out of the address and the step is considered
export function watchStep(
  store: PasskeysStore = passkeys,
  address: Address = browserAddress,
): () => void {
  return effect(() => {
    if (!me.value) return;
    untracked(() => {
      const t = takeSignedIn(address.search());
      if (!t.found) return;
      address.replace(t.search);
      void store.considerStep();
    });
  });
}
