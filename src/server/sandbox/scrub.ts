// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// OpenShell never redacts a response, so a server that echoes a signed
// request hands the real key to the command. Every key the send read is
// replaced in what the command leaves, as in its output: the pulled
// files before they commit, and the records open copied.

import {
  type CommandCredential,
  escapedForms,
  scrubBytes,
  scrubKeys,
} from "../bash/index.ts";
import type { PullFrame } from "./pull.ts";
import type { Readout } from "./readout.ts";

// the readout's pulled bytes replaced in place; the frames returned
// scrubbed for the records read from them
export function scrubPulled(
  read: Readout,
  frames: readonly PullFrame[],
  credentials: readonly CommandCredential[],
): readonly PullFrame[] {
  if (!credentials.some((credential) => "key" in credential)) return frames;
  for (const { entry } of read.pulls.values()) {
    if (entry.bytes !== undefined)
      entry.bytes = scrubBytes(entry.bytes, credentials);
  }
  return frames.map((frame) =>
    frame.missing
      ? frame
      : { ...frame, data: scrubBytes(frame.data, credentials) },
  );
}

// What a command's stream keeps: past what a result shows at 4 bytes a
// character, the longest form of a key, so a key the cut crosses is
// still whole for the scrub. The rest is drained.
export function outputBytes(
  resultCut: number,
  credentials: readonly CommandCredential[],
): number {
  let longest = 0;
  for (const credential of credentials)
    if ("key" in credential)
      for (const form of escapedForms(credential.key))
        longest = Math.max(longest, Buffer.byteLength(form));
  return 4 * resultCut + longest;
}

// A stream's kept bytes when it was cut: the cut may end inside a key,
// whose start no form matches, so a tail that begins any form is
// dropped. The scrub shortens what it replaces, so that tail could
// otherwise reach the result. Whole keys are scrubbed first, since one
// whose last character starts a form would lose it to the trim.
export function keptText(
  text: string,
  cut: boolean,
  credentials: readonly CommandCredential[],
): string {
  if (!cut) return text;
  text = scrubKeys(text, credentials);
  let drop = 0;
  for (const credential of credentials) {
    if (!("key" in credential)) continue;
    for (const form of escapedForms(credential.key))
      for (let n = Math.min(form.length - 1, text.length); n > drop; n--)
        if (text.endsWith(form.slice(0, n))) {
          drop = n;
          break;
        }
  }
  return text.slice(0, text.length - drop);
}
