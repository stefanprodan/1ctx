// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The process-wide bound on image decodes. A waiter queues under the
// upload's own deadline and is never refused for the queue alone.

import { Queue } from "../lib/queue.ts";
import { MAX_DECODES } from "./limits.ts";

const decodes = new Queue(MAX_DECODES);

export async function decoding<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  const release = await decodes.acquire(signal);
  try {
    return await work();
  } finally {
    release();
  }
}
