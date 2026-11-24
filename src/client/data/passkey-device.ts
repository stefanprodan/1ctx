// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The browser's side of passkeys, behind one small port so the store is
// tried without a browser. create() and get() call the browser before
// they return, never after an await, since iOS runs them only inside
// the tap.

import {
  type Asserted,
  type AssertionJSON,
  type Attested,
  assertionOf,
  type CreationJSON,
  creationOf,
  type RegistrationJSON,
  type RequestJSON,
  registrationOf,
  requestOf,
} from "../lib/passkeys.ts";

export type PasskeyDevice = {
  supported(): boolean;
  // Face ID, Touch ID or Windows Hello on this device
  platform(): Promise<boolean>;
  // passkeys offered in a field's autofill (conditional mediation)
  autofill(): Promise<boolean>;
  origin(): string;
  // each calls the browser before it returns, never after an await
  create(o: CreationJSON): Promise<RegistrationJSON>;
  // with a signal: the autofill's request, held open until it is aborted
  get(o: RequestJSON, autofill?: AbortSignal): Promise<AssertionJSON>;
  // a passkey this server no longer holds, so the password manager stops
  // offering it (the Signal API, where the browser has it)
  forget(credentialId: string): void;
  // a hidden tab's timers fire late or never, so it refreshes on return
  hidden(): boolean;
  onVisible(fire: () => void): () => void;
};

type Browser = {
  PublicKeyCredential?: {
    isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
    isConditionalMediationAvailable?: () => Promise<boolean>;
    signalUnknownCredential?: (o: {
      rpId: string;
      credentialId: string;
    }) => Promise<void>;
  };
  navigator?: {
    credentials?: {
      create(o: unknown): Promise<unknown>;
      get(o: unknown): Promise<unknown>;
    };
  };
  location?: { origin: string; hostname: string };
  document?: Document;
};

const nothing = () => new DOMException("no passkey", "NotAllowedError");

export function browserPasskeys(): PasskeyDevice {
  const w = globalThis as Browser;
  const creds = () => w.navigator!.credentials!;
  return {
    supported: () =>
      typeof w.PublicKeyCredential === "function" &&
      w.navigator?.credentials !== undefined,
    async platform() {
      const ask =
        w.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable;
      return ask === undefined ? false : ask.call(w.PublicKeyCredential);
    },
    forget(credentialId) {
      const signal = w.PublicKeyCredential?.signalUnknownCredential;
      const rpId = w.location?.hostname;
      if (signal === undefined || rpId === undefined) return;
      try {
        signal
          .call(w.PublicKeyCredential, { rpId, credentialId })
          .catch(() => {});
      } catch {}
    },
    async autofill() {
      const ask = w.PublicKeyCredential?.isConditionalMediationAvailable;
      return ask === undefined ? false : ask.call(w.PublicKeyCredential);
    },
    origin: () => w.location?.origin ?? "",
    hidden: () => w.document?.hidden === true,
    onVisible(fire) {
      const d = w.document;
      if (d === undefined) return () => {};
      const seen = () => {
        if (!d.hidden) fire();
      };
      d.addEventListener("visibilitychange", seen);
      return () => d.removeEventListener("visibilitychange", seen);
    },
    create(o) {
      try {
        return creds()
          .create({ publicKey: creationOf(o) })
          .then((c) => {
            if (c === null) throw nothing();
            return registrationOf(c as Attested);
          });
      } catch (e) {
        return Promise.reject(e);
      }
    },
    get(o, autofill) {
      try {
        return creds()
          .get(
            autofill === undefined
              ? { publicKey: requestOf(o) }
              : {
                  publicKey: requestOf(o),
                  mediation: "conditional",
                  signal: autofill,
                },
          )
          .then((c) => {
            if (c === null) throw nothing();
            return assertionOf(c as Asserted);
          });
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
}
