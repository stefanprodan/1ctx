// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { ApiError } from "../../../src/client/data/api.ts";
import { me } from "../../../src/client/data/me.ts";
import type { PasskeyDevice } from "../../../src/client/data/passkey-device.ts";
import {
  type Address,
  dropSignedIn,
  type Later,
  PASSKEY_OPTIONS_PATH,
  PASSKEY_SIGN_IN_OPTIONS_PATH,
  PASSKEY_SIGN_IN_PATH,
  PASSKEYS_PATH,
  passkeysStore,
  watchStep,
} from "../../../src/client/data/passkeys.ts";
import {
  type AssertionJSON,
  assertionOf,
  type CreationJSON,
  cancelled,
  creationOf,
  fresh,
  fromB64url,
  LEEWAY_MS,
  passkeyWords,
  type RegistrationJSON,
  type RequestJSON,
  refreshIn,
  registrationOf,
  requestOf,
  takeSignedIn,
  toB64url,
} from "../../../src/client/lib/passkeys.ts";
import type { Passkey } from "../../../src/shared/api/profile.ts";
import { settle } from "../../helpers/async.ts";

const HOST = "1ctx.example.com";
const ORIGIN = `https://${HOST}`;
// the same host on another port
const LOCAL = "http://localhost:11236";
const NOW = Date.UTC(2026, 10, 24, 12, 0);
const bytes = (...v: number[]) => new Uint8Array(v).buffer;
const b64 = (...v: number[]) => toB64url(new Uint8Array(v));

const item = (over: Partial<Passkey> = {}): Passkey => ({
  id: "pk1",
  credentialId: "Y3JlZC0x",
  origin: ORIGIN,
  device: "Apple Passwords",
  createdAt: Date.UTC(2026, 10, 12, 9),
  lastUsedAt: null,
  ...over,
});

const CREATION: CreationJSON = {
  challenge: b64(1, 2, 3),
  rp: { id: HOST, name: "1ctx" },
  user: { id: b64(111, 112), name: "ana@example.com", displayName: "Ana" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  timeout: 120_000,
  attestation: "none",
  authenticatorSelection: {
    residentKey: "required",
    requireResidentKey: true,
    userVerification: "required",
  },
  excludeCredentials: [
    { type: "public-key", id: b64(9), transports: ["internal"] },
  ],
};

const REQUEST: RequestJSON = {
  challenge: b64(4, 5, 6),
  rpId: HOST,
  timeout: 120_000,
  userVerification: "required",
  allowCredentials: [],
};

const REGISTRATION: RegistrationJSON = {
  id: b64(7, 7),
  rawId: b64(7, 7),
  type: "public-key",
  response: {
    clientDataJSON: b64(1),
    authenticatorData: b64(2),
    publicKey: b64(3),
    publicKeyAlgorithm: -7,
    transports: ["internal"],
  },
};

const ASSERTION: AssertionJSON = {
  id: b64(7, 7),
  rawId: b64(7, 7),
  type: "public-key",
  response: {
    clientDataJSON: b64(1),
    authenticatorData: b64(2),
    signature: b64(3),
    userHandle: b64(111),
  },
};

describe("base64url", () => {
  test("round-trips every length, with no padding and no + or /", () => {
    for (const v of [[], [0], [251, 255], [62, 63, 255], [1, 2, 3, 4, 5]]) {
      const s = toB64url(new Uint8Array(v));
      expect(s).not.toMatch(/[+/=]/);
      expect([...new Uint8Array(fromB64url(s))]).toEqual(v);
    }
    expect(toB64url(new Uint8Array([251, 255]))).toBe("-_8");
  });

  test("options turn their base64url fields into bytes", () => {
    const c = creationOf(CREATION);
    expect([...new Uint8Array(c.challenge)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(c.user.id)]).toEqual([111, 112]);
    expect(c.user.name).toBe("ana@example.com");
    expect([...new Uint8Array(c.excludeCredentials[0]!.id)]).toEqual([9]);
    expect(c.excludeCredentials[0]!.transports).toEqual(["internal"]);
    const r = requestOf(REQUEST);
    expect([...new Uint8Array(r.challenge)]).toEqual([4, 5, 6]);
    expect(r.rpId).toBe(HOST);
  });
});

describe("the browser's answers", () => {
  const getters = {
    clientDataJSON: bytes(1),
    getAuthenticatorData: () => bytes(2),
    getPublicKey: () => bytes(3),
    getPublicKeyAlgorithm: () => -7,
    getTransports: () => ["internal"],
  };

  test("an add's answer is built from the getters without toJSON", () => {
    expect(
      // the id is the raw bytes' form, whatever the browser put in id
      registrationOf({
        id: "made-up+id",
        rawId: bytes(7, 7),
        response: getters,
      }),
    ).toEqual(REGISTRATION);
  });

  test("toJSON is taken where it works, and a throwing one falls back", () => {
    const fromJson = registrationOf({
      id: b64(7, 7),
      rawId: bytes(7, 7),
      toJSON: () => ({
        response: { ...REGISTRATION.response, publicKey: b64(8) },
      }),
      response: getters,
    });
    expect(fromJson.response.publicKey).toBe(b64(8));
    const broken = registrationOf({
      id: b64(7, 7),
      rawId: bytes(7, 7),
      toJSON: () => {
        throw new Error("made-up");
      },
      response: getters,
    });
    expect(broken).toEqual(REGISTRATION);
  });

  test("a sign-in's answer keeps a missing user handle null", () => {
    const r = {
      clientDataJSON: bytes(1),
      authenticatorData: bytes(2),
      signature: bytes(3),
      userHandle: bytes(111),
    };
    expect(
      assertionOf({ id: "made-up+id", rawId: bytes(7, 7), response: r }),
    ).toEqual(ASSERTION);
    expect(
      assertionOf({
        id: b64(7, 7),
        rawId: bytes(7, 7),
        response: { ...r, userHandle: null },
      }).response.userHandle,
    ).toBeNull();
  });
});

describe("the options' freshness", () => {
  test("options serve until the leeway before their timeout", () => {
    expect(fresh(NOW, 120_000, NOW)).toBe(true);
    expect(fresh(NOW, 120_000, NOW + 120_000 - LEEWAY_MS - 1)).toBe(true);
    expect(fresh(NOW, 120_000, NOW + 120_000 - LEEWAY_MS)).toBe(false);
    expect(refreshIn(NOW, 120_000, NOW + 10_000)).toBe(
      120_000 - LEEWAY_MS - 10_000,
    );
    expect(refreshIn(NOW, 120_000, NOW + 500_000)).toBe(0);
  });
});

describe("the emailed sign-in's flag", () => {
  test("is taken from the address, the rest kept", () => {
    expect(takeSignedIn("?signed_in=1")).toEqual({ found: true, search: "" });
    expect(takeSignedIn("?tab=all&signed_in=1")).toEqual({
      found: true,
      search: "?tab=all",
    });
    expect(takeSignedIn("?tab=all")).toEqual({
      found: false,
      search: "?tab=all",
    });
    expect(takeSignedIn("")).toEqual({ found: false, search: "" });
    // only the landing's own value asks, any other goes all the same
    expect(takeSignedIn("?signed_in=0")).toEqual({ found: false, search: "" });
  });

  test("a sign-in by key or passkey drops it, so it asks no step", () => {
    let search = "?a=1&signed_in=1";
    const address: Address = {
      search: () => search,
      replace: (s) => {
        search = s;
      },
    };
    dropSignedIn(address);
    expect(search).toBe("?a=1");
    dropSignedIn(address);
    expect(search).toBe("?a=1");
  });
});

const unknown = () =>
  new ApiError(401, "passkey not accepted", {
    error: "passkey not accepted",
    code: "unknown_passkey",
  });

describe("failures", () => {
  test("a cancel says nothing; the rest say what happened", () => {
    const cancel = new DOMException("made-up", "NotAllowedError");
    expect(cancelled(cancel)).toBe(true);
    expect(passkeyWords(cancel, true)).toBeNull();
    expect(
      passkeyWords(new DOMException("made-up", "AbortError"), false),
    ).toBeNull();
    expect(
      passkeyWords(new DOMException("made-up", "InvalidStateError"), true),
    ).toBe("This device already has a passkey.");
    expect(
      passkeyWords(new DOMException("made-up", "SecurityError"), true),
    ).toBe("The passkey was not added.");
    expect(
      passkeyWords(new DOMException("made-up", "SecurityError"), false),
    ).toBe("The passkey did not work.");
    expect(
      passkeyWords(new ApiError(409, "at most 10 passkeys a user"), true),
    ).toBe("At most 10 passkeys a user.");
    expect(passkeyWords(unknown(), false)).toBe(
      "This passkey was removed. Sign in another way.",
    );
    expect(
      passkeyWords(new ApiError(0, "the server did not answer"), false),
    ).toBe("The server did not answer.");
  });
});

function laterFake() {
  const timers: { ms: number; fire: () => void; live: boolean }[] = [];
  const later: Later = (ms, fire) => {
    const t = { ms, fire, live: true };
    timers.push(t);
    return () => {
      t.live = false;
    };
  };
  return { later, live: () => timers.filter((t) => t.live) };
}

type Held = {
  signal: AbortSignal;
  answer: PromiseWithResolvers<AssertionJSON>;
};

function deviceFake(platform = true, autofill = false) {
  const order: string[] = [];
  const state = {
    origin: ORIGIN as string,
    refuse: null as Error | null,
    // an add's sheet still open, answered when the test says
    asking: null as PromiseWithResolvers<RegistrationJSON> | null,
    hidden: false,
    visible: [] as (() => void)[],
    // the autofill's requests, answered when the test says
    held: [] as Held[],
  };
  const device: PasskeyDevice = {
    supported: () => true,
    platform: async () => platform,
    autofill: async () => autofill,
    origin: () => state.origin,
    forget(credentialId) {
      order.push(`forget ${credentialId}`);
    },
    hidden: () => state.hidden,
    onVisible(fire) {
      state.visible.push(fire);
      return () => {
        state.visible = state.visible.filter((f) => f !== fire);
      };
    },
    create(o) {
      order.push(`create ${o.challenge}`);
      if (state.asking !== null) return state.asking.promise;
      return state.refuse === null
        ? Promise.resolve(REGISTRATION)
        : Promise.reject(state.refuse);
    },
    get(o, signal) {
      if (signal === undefined) {
        order.push(`get ${o.challenge}`);
        return Promise.resolve(ASSERTION);
      }
      order.push(`autofill ${o.challenge}`);
      const answer = Promise.withResolvers<AssertionJSON>();
      signal.addEventListener("abort", () =>
        answer.reject(new DOMException("made-up", "AbortError")),
      );
      state.held.push({ signal, answer });
      return answer.promise;
    },
  };
  return { device, order, state };
}

// the server, as the store's call and the sign-in's post see it
function server(list: Passkey[] = []) {
  const knobs = {
    addStatus: 201,
    // a sign-in's refusal, or null for a sign-in
    signIn: null as ApiError | null,
    optionsGate: null as Promise<void> | null,
    listGate: null as Promise<void> | null,
    optionsFail: 0,
  };
  const asked: { to: string; method: string; body: unknown }[] = [];
  let challenge = 0;
  const call = async <T>(
    to: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> => {
    asked.push({ to, method, body: body ?? null });
    if (to === PASSKEY_OPTIONS_PATH || to === PASSKEY_SIGN_IN_OPTIONS_PATH) {
      if (knobs.optionsGate !== null) await knobs.optionsGate;
      if (knobs.optionsFail > 0) {
        knobs.optionsFail--;
        throw new ApiError(503, "the server failed while answering");
      }
      const base = to === PASSKEY_OPTIONS_PATH ? CREATION : REQUEST;
      return { ...base, challenge: b64(++challenge) } as T;
    }
    if (to === PASSKEYS_PATH && method === "GET") {
      const now = [...list];
      if (knobs.listGate !== null) await knobs.listGate;
      return { passkeys: now } as T;
    }
    if (to === PASSKEYS_PATH && method === "POST") {
      if (knobs.addStatus !== 201) {
        throw new ApiError(knobs.addStatus, "the passkey did not check out");
      }
      const added = item({ id: "new" });
      list.push(added);
      return added as T;
    }
    if (to.startsWith(`${PASSKEYS_PATH}/`)) return undefined as T;
    throw new Error(`unexpected ${method} ${to}`);
  };
  const post = async (to: string, body: unknown) => {
    asked.push({ to, method: "POST", body });
    if (knobs.signIn !== null) throw knobs.signIn;
    return { landing: "/" };
  };
  return { call, post, asked, knobs };
}

const optionsAsked = (
  s: ReturnType<typeof server>,
  to = PASSKEY_OPTIONS_PATH,
) => s.asked.filter((a) => a.to === to).length;

function made(list: Passkey[] = [], platform = true, autofill = false) {
  let now = NOW;
  let session = 1;
  let opens = 0;
  const s = server(list);
  const l = laterFake();
  const d = deviceFake(platform, autofill);
  const st = passkeysStore({
    call: s.call,
    post: s.post,
    opened: async () => {
      opens++;
    },
    session: () => session,
    device: d.device,
    now: () => now,
    later: l.later,
  });
  return {
    st,
    s,
    l,
    d,
    tick: (ms: number) => (now += ms),
    // what a sign-out does to the store
    signOut: () => {
      session++;
      st.signedOut();
    },
    opens: () => opens,
  };
}

describe("the passkeys store", () => {
  test("a tap calls the browser at once with options fetched before it", async () => {
    const m = made();
    const release = m.st.prime("add");
    await settle();
    expect(optionsAsked(m.s)).toBe(1);
    const adding = m.st.add();
    // before any await: create() ran inside the tap
    expect(m.d.order).toEqual([`create ${b64(1)}`]);
    expect(await adding).toBe(true);
    expect(
      m.s.asked.find((a) => a.method === "POST" && a.to === PASSKEYS_PATH)
        ?.body,
    ).toEqual(REGISTRATION);
    expect(m.st.list.value?.map((p) => p.id)).toEqual(["new"]);
    // each challenge is used once: the next tap has new options
    await settle();
    expect(optionsAsked(m.s)).toBe(2);
    release();
  });

  test("options past their freshness are fetched again before the tap", async () => {
    const m = made();
    const release = m.st.prime("add");
    await settle();
    const timer = m.l.live().at(-1)!;
    expect(timer.ms).toBe(120_000 - LEEWAY_MS);
    m.tick(timer.ms);
    timer.fire();
    await settle();
    expect(optionsAsked(m.s)).toBe(2);
    expect(await m.st.add()).toBe(true);
    expect(m.d.order).toEqual([`create ${b64(2)}`]);
    release();
    await settle();
    expect(m.l.live()).toHaveLength(0);
  });

  test("a tap on stale options only fetches them, never then the browser", async () => {
    const m = made();
    const release = m.st.prime("add");
    await settle();
    release();
    m.tick(120_000);
    const tapped = m.st.add();
    expect(m.st.waiting("add")).toBe(true);
    expect(await tapped).toBe(false);
    expect(m.d.order).toEqual([]);
    expect(optionsAsked(m.s)).toBe(2);
    expect(m.st.waiting("add")).toBe(false);
    expect(m.st.error.value).toBeNull();
    // the next tap has them
    expect(await m.st.add()).toBe(true);
    expect(m.d.order).toEqual([`create ${b64(2)}`]);
  });

  test("a sign-in tap on stale options only fetches them", async () => {
    const m = made();
    const release = m.st.prime("sign_in");
    await settle();
    release();
    m.tick(120_000);
    await m.st.signIn(() => {});
    expect(m.d.order).toEqual([]);
    expect(m.s.asked.some((a) => a.to === PASSKEY_SIGN_IN_PATH)).toBe(false);
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(2);
    const landed: string[] = [];
    await m.st.signIn((to) => landed.push(to));
    expect(m.d.order).toEqual([`get ${b64(2)}`]);
    expect(landed).toEqual(["/"]);
  });

  test("an add still asking when the session ends sends nothing", async () => {
    const m = made();
    const release = m.st.prime("add");
    await settle();
    m.d.state.asking = Promise.withResolvers<RegistrationJSON>();
    const adding = m.st.add();
    expect(m.st.busy.value).toBe(true);
    m.signOut();
    expect(m.st.busy.value).toBe(false);
    release();
    const asked = optionsAsked(m.s);
    m.d.state.asking.resolve(REGISTRATION);
    expect(await adding).toBe(false);
    await settle();
    expect(
      m.s.asked.some((a) => a.method === "POST" && a.to === PASSKEYS_PATH),
    ).toBe(false);
    // nor fetches the next options for a session that is gone
    expect(optionsAsked(m.s)).toBe(asked);
    expect(m.st.busy.value).toBe(false);
    expect(m.st.error.value).toBeNull();
  });

  test("a remove drops the row and fetches the add's options again", async () => {
    const m = made([item()]);
    const release = m.st.prime("add");
    await m.st.read();
    await m.st.remove("pk1");
    expect(
      m.s.asked.some(
        (a) => a.method === "DELETE" && a.to === `${PASSKEYS_PATH}/pk1`,
      ),
    ).toBe(true);
    expect(m.st.list.value).toEqual([]);
    await settle();
    expect(optionsAsked(m.s)).toBe(2);
    release();
  });

  test("a removed passkey of this host is forgotten by the browser, another's not", async () => {
    const m = made([
      item(),
      item({ id: "pk2", credentialId: "b3RoZXI", origin: LOCAL }),
    ]);
    await m.st.read();
    await m.st.remove("pk2");
    expect(m.d.order).toEqual([]);
    await m.st.remove("pk1");
    expect(m.d.order).toEqual(["forget Y3JlZC0x"]);
  });

  test("a passkey the server does not hold is forgotten and says so", async () => {
    const m = made();
    const release = m.st.prime("sign_in");
    await settle();
    m.s.knobs.signIn = unknown();
    const err = await m.st.signIn(() => {}).catch((e: unknown) => e);
    expect(m.d.order).toEqual([`get ${b64(1)}`, `forget ${ASSERTION.id}`]);
    expect(passkeyWords(err, false)).toBe(
      "This passkey was removed. Sign in another way.",
    );
    expect(m.opens()).toBe(0);
    release();
  });

  test("an unknown passkey on loopback is not forgotten: another install may hold it", async () => {
    const m = made();
    m.d.state.origin = LOCAL;
    const release = m.st.prime("sign_in");
    await settle();
    m.s.knobs.signIn = unknown();
    await m.st.signIn(() => {}).catch(() => {});
    expect(m.d.order).toEqual([`get ${b64(1)}`]);
    release();
  });

  test("a passkey refused for another reason is not forgotten", async () => {
    const m = made();
    const release = m.st.prime("sign_in");
    await settle();
    m.s.knobs.signIn = new ApiError(401, "passkey not accepted", {
      error: "passkey not accepted",
    });
    const err = await m.st.signIn(() => {}).catch((e: unknown) => e);
    expect(m.d.order).toEqual([`get ${b64(1)}`]);
    expect(passkeyWords(err, false)).toBe("Passkey not accepted.");
    // a refused tap's challenge is spent: new options follow
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(2);
    release();
  });

  test("a failed options refresh tries again", async () => {
    const m = made();
    const release = m.st.prime("sign_in");
    await settle();
    m.s.knobs.optionsFail = 1;
    m.l.live().at(-1)!.fire();
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(2);
    const retry = m.l.live().at(-1)!;
    expect(retry.ms).toBe(30_000);
    retry.fire();
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(3);
    expect(m.l.live().at(-1)!.ms).toBeGreaterThan(30_000);
    release();
  });

  test("options answered late count their freshness from the ask", async () => {
    const m = made();
    const gate = Promise.withResolvers<void>();
    m.s.knobs.optionsGate = gate.promise;
    const release = m.st.prime("add");
    m.tick(100_000);
    m.s.knobs.optionsGate = null;
    gate.resolve();
    await settle();
    // past their leeway already: the tap only fetches new ones
    expect(await m.st.add()).toBe(false);
    expect(m.d.order).toEqual([]);
    release();
  });

  test("an add before the list has loaded keeps the passkeys already there", async () => {
    const m = made([item()]);
    const gate = Promise.withResolvers<void>();
    m.s.knobs.listGate = gate.promise;
    const reading = m.st.read();
    const release = m.st.prime("add");
    await settle();
    m.s.knobs.listGate = null;
    expect(await m.st.add()).toBe(true);
    gate.resolve();
    await reading;
    await settle();
    expect(m.st.list.value?.map((p) => p.id)).toContain("pk1");
    release();
  });

  test("a passkey sign-in posts the browser's answer, lands where answered and reads who it is", async () => {
    const m = made();
    const release = m.st.prime("sign_in");
    await settle();
    const landed: string[] = [];
    const signing = m.st.signIn((to) => landed.push(to));
    expect(m.d.order).toEqual([`get ${b64(1)}`]);
    await signing;
    expect(m.s.asked.find((a) => a.to === PASSKEY_SIGN_IN_PATH)?.body).toEqual(
      ASSERTION,
    );
    expect(landed).toEqual(["/"]);
    expect(m.opens()).toBe(1);
    // a sign-in done needs no next challenge
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(1);
    release();
  });

  test("an autofill's answer is posted without asking the browser", async () => {
    const m = made();
    const landed: string[] = [];
    await m.st.signIn((to) => landed.push(to), ASSERTION);
    expect(m.d.order).toEqual([]);
    expect(m.s.asked.find((a) => a.to === PASSKEY_SIGN_IN_PATH)?.body).toEqual(
      ASSERTION,
    );
    expect(landed).toEqual(["/"]);
  });

  test("the passkey step is offered on every call where a platform authenticator is", async () => {
    // a passkey already here changes nothing: the step asks each time
    const m = made([item()]);
    await m.st.considerStep();
    expect(m.st.step.value).toBe(true);
    m.st.step.value = false;
    await m.st.considerStep();
    expect(m.st.step.value).toBe(true);
    const none = made([], false);
    await none.st.considerStep();
    expect(none.st.step.value).toBe(false);
  });

  test("an added passkey ends the step", async () => {
    const m = made();
    await m.st.considerStep();
    const release = m.st.prime("add");
    await settle();
    expect(await m.st.add()).toBe(true);
    expect(m.st.step.value).toBe(false);
    release();
  });

  test("a cancelled tap says nothing and fetches new options", async () => {
    const m = made();
    const release = m.st.prime("add");
    await settle();
    m.d.state.refuse = new DOMException("made-up", "NotAllowedError");
    expect(await m.st.add()).toBe(false);
    expect(m.st.error.value).toBeNull();
    await settle();
    expect(optionsAsked(m.s)).toBe(2);
    release();
  });

  test("a refused answer says so and fetches new options", async () => {
    const m = made();
    const release = m.st.prime("add");
    await settle();
    m.s.knobs.addStatus = 400;
    expect(await m.st.add()).toBe(false);
    expect(m.st.error.value).toBe("The passkey did not check out.");
    await settle();
    expect(optionsAsked(m.s)).toBe(2);
    m.s.knobs.addStatus = 201;
    expect(await m.st.add()).toBe(true);
    expect(m.d.order.at(-1)).toBe(`create ${b64(2)}`);
    release();
  });

  test("a hidden tab skips the refresh and fetches stale options once shown", async () => {
    const m = made();
    const release = m.st.prime("sign_in");
    await settle();
    m.d.state.hidden = true;
    const timer = m.l.live().at(-1)!;
    m.tick(timer.ms);
    timer.fire();
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(1);
    m.d.state.hidden = false;
    for (const f of m.d.state.visible) f();
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(2);
    // shown again with fresh options: nothing more
    for (const f of m.d.state.visible) f();
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(2);
    release();
    expect(m.d.state.visible).toHaveLength(0);
  });

  test("a sign-out drops the options, the list and the step", async () => {
    const m = made([item()]);
    const release = m.st.prime("add");
    await m.st.read();
    await m.st.considerStep();
    await settle();
    m.signOut();
    expect(m.st.list.value).toBeNull();
    expect(m.st.step.value).toBe(false);
    // the options of the session before are never used: the tap fetches
    expect(await m.st.add()).toBe(false);
    expect(m.d.order).toEqual([]);
    expect(await m.st.add()).toBe(true);
    expect(m.d.order).toEqual([`create ${b64(2)}`]);
    release();
  });

  test("a failed read is kept for the card, and a later read clears it", async () => {
    const m = made();
    m.s.knobs.listGate = Promise.reject(new ApiError(500, "boom"));
    m.s.knobs.listGate.catch(() => {});
    await m.st.read();
    expect(m.st.failed.value).toEqual({ words: "boom", status: 500 });
    m.s.knobs.listGate = null;
    await m.st.read();
    expect(m.st.failed.value).toBeNull();
    expect(m.st.list.value).toEqual([]);
  });
});

describe("the autofill", () => {
  test("holds a request on the primed options and restarts it on fresh ones", async () => {
    const m = made([], true, true);
    const answers: AssertionJSON[] = [];
    const release = m.st.listen((a) => answers.push(a));
    await settle();
    expect(m.d.order).toEqual([`autofill ${b64(1)}`]);
    const timer = m.l.live().at(-1)!;
    m.tick(timer.ms);
    timer.fire();
    await settle();
    expect(m.d.state.held[0]!.signal.aborted).toBe(true);
    expect(m.d.order).toEqual([`autofill ${b64(1)}`, `autofill ${b64(2)}`]);
    // an aborted request fetches nothing more
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(2);
    m.d.state.held[1]!.answer.resolve(ASSERTION);
    await settle();
    expect(answers).toEqual([ASSERTION]);
    // its challenge is spent, so a tap only fetches new options
    expect(await m.st.assert()).toBeNull();
    expect(m.d.order.some((o) => o.startsWith("get"))).toBe(false);
    release();
  });

  test("a refused request waits for the next refresh; the release aborts it", async () => {
    const m = made([], true, true);
    const answers: AssertionJSON[] = [];
    const release = m.st.listen((a) => answers.push(a));
    await settle();
    m.d.state.held[0]!.answer.reject(
      new DOMException("made-up", "NotAllowedError"),
    );
    await settle();
    // a browser refusing every request would otherwise loop on the options
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(1);
    expect(m.d.order).toEqual([`autofill ${b64(1)}`]);
    m.l.live().at(-1)!.fire();
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(2);
    expect(m.d.order).toEqual([`autofill ${b64(1)}`, `autofill ${b64(2)}`]);
    release();
    expect(m.d.state.held[1]!.signal.aborted).toBe(true);
    await settle();
    expect(answers).toEqual([]);
    expect(m.l.live()).toHaveLength(0);
    expect(m.d.state.visible).toHaveLength(0);
  });

  test("a tap's request first aborts the autofill's, as a browser holds one", async () => {
    const m = made([], true, true);
    const stop = m.st.listen(() => {});
    await settle();
    const signing = m.st.signIn(() => {});
    expect(m.d.state.held[0]!.signal.aborted).toBe(true);
    expect(m.d.order).toEqual([`autofill ${b64(1)}`, `get ${b64(1)}`]);
    await signing;
    stop();
  });
});

function addressFake(search: string) {
  const a = { now: search, replaced: [] as string[] };
  const address: Address = {
    search: () => a.now,
    replace: (s) => {
      a.now = s;
      a.replaced.push(s);
    },
  };
  return { a, address };
}

const user = {
  id: "u1",
  username: "ana",
  fullName: "Ana",
  role: "member" as const,
};

describe("the passkey step's watch", () => {
  test.serial(
    "strips the flag, keeps the rest of the address and offers on each sign-in",
    async () => {
      const m = made();
      const f = addressFake("?tab=all&signed_in=1");
      me.value = null;
      const stop = watchStep(m.st, f.address);
      try {
        me.value = user;
        await settle();
        expect(f.a.replaced).toEqual(["?tab=all"]);
        expect(m.st.step.value).toBe(true);
        // skipped, and a later change of the row finds no flag
        m.st.step.value = false;
        me.value = { ...user, fullName: "Ana B" };
        await settle();
        expect(f.a.replaced).toEqual(["?tab=all"]);
        expect(m.st.step.value).toBe(false);
        me.value = null;
        f.a.now = "?signed_in=1";
        me.value = user;
        await settle();
        expect(f.a.replaced).toEqual(["?tab=all", ""]);
        expect(m.st.step.value).toBe(true);
      } finally {
        stop();
        me.value = undefined;
      }
    },
  );

  test.serial(
    "strips the flag but offers nothing without a platform authenticator",
    async () => {
      const m = made([], false);
      const f = addressFake("?signed_in=1");
      const stop = watchStep(m.st, f.address);
      try {
        me.value = user;
        await settle();
        expect(f.a.replaced).toEqual([""]);
        expect(m.st.step.value).toBe(false);
      } finally {
        stop();
        me.value = undefined;
      }
    },
  );
});
