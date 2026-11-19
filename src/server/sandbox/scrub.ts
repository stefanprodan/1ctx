// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// OpenShell never redacts a response, so a server that echoes a signed
// request hands the real key to the command. Every key the send read is
// replaced in what the command leaves, as in its output: the pulled
// files before they commit, and the records open copied.

import { type CommandCredential, scrubBytes } from "../bash/index.ts";
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
