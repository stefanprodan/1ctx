// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The process-wide bound on image decodes. A waiter queues under the
// upload's own deadline and is never refused for the queue alone. An
// upload takes its place before its process slot, never inside one.

import { Queue } from "../lib/queue.ts";
import { MAX_DECODES } from "./limits.ts";

const decodes = new Queue(MAX_DECODES);

export const acquireDecode = (signal: AbortSignal) => decodes.acquire(signal);
