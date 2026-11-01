// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One line for the tab's uploads, files and images alike: the server
// runs one upload per user, so a mixed pick has each wait for the one
// before it to settle instead of being refused and trying again. A 409
// is then left to an upload from elsewhere (another tab). An upload
// let go while it waits leaves the line at once and never starts.

const aborted = () =>
  new DOMException("The operation was aborted.", "AbortError");

export function uploadLine() {
  let tail: Promise<void> = Promise.resolve();
  return function inLine<T>(
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const before = tail;
    let done!: () => void;
    tail = new Promise<void>((settle) => {
      done = settle;
    });
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(aborted());
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });
      void before.then(async () => {
        signal?.removeEventListener("abort", stop);
        if (signal?.aborted) {
          done();
          return;
        }
        try {
          resolve(await run());
        } catch (error) {
          reject(error);
        } finally {
          done();
        }
      });
    });
  };
}

export const inUploadLine = uploadLine();
