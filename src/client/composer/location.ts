// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// /location: the user's position as a line under their question. It is
// a message, not an action, so the words here only build its text; the
// browser is asked once, on Enter, and never in the background.

export type Fix = { latitude: number; longitude: number; accuracy: number };

// one read of the position; rejects with the failure line's words
export type Locate = () => Promise<Fix>;

export const NEEDS_HTTPS = "/location: needs https";

// some browsers answer neither way while the prompt is left open, and
// the read's own timeout skips the prompt, so a read is given up here
export const READ_LIMIT_MS = 30_000;

export type Timer = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// five decimals is about a metre, finer than any browser's accuracy
export function locationLine(fix: Fix): string {
  const at = `${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}`;
  return `My location: ${at} (±${Math.round(fix.accuracy)} m)`;
}

// the question and the line after it, or the line alone
export function locationMessage(question: string, fix: Fix): string {
  const asked = question.trim();
  const line = locationLine(fix);
  return asked === "" ? line : `${asked}\n\n${line}`;
}

// a GeolocationPositionError code as the failure line says it
export function locationFailure(code: number): string {
  return code === 1
    ? "/location: blocked in the browser"
    : "/location: no position found";
}

// the browser shares a position only in a secure context
export function locationAvailable(
  secure: boolean | undefined,
  nav: object | undefined,
): boolean {
  return secure === true && nav !== undefined && "geolocation" in nav;
}

// the message Enter sends, or a refusal when there is no reader
export async function locate(
  question: string,
  read: Locate | null,
): Promise<string> {
  if (read === null) throw new Error(NEEDS_HTTPS);
  return locationMessage(question, await read());
}

// the read, or no position once the limit passes without an answer
export function bounded(
  read: Locate,
  timer: Timer = realTimer,
  ms = READ_LIMIT_MS,
): Locate {
  return () =>
    new Promise((done, fail) => {
      const handle = timer.set(() => fail(new Error(locationFailure(3))), ms);
      read().then(
        (fix) => {
          timer.clear(handle);
          done(fix);
        },
        (err) => {
          timer.clear(handle);
          fail(err);
        },
      );
    });
}

// the browser's reader, null where it cannot share a position
export function browserLocate(): Locate | null {
  if (!locationAvailable(globalThis.isSecureContext, globalThis.navigator)) {
    return null;
  }
  return bounded(
    () =>
      new Promise((done, fail) => {
        navigator.geolocation.getCurrentPosition(
          ({ coords }) =>
            done({
              latitude: coords.latitude,
              longitude: coords.longitude,
              accuracy: coords.accuracy,
            }),
          (err) => fail(new Error(locationFailure(err.code))),
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
        );
      }),
  );
}
