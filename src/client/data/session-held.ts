// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat on screen, apart from the entity that loads and reconciles
// it (sessions.ts), so the queue's half (session-queue.ts) writes it
// without an import cycle.

import { signal } from "@preact/signals";
import type { SessionDetail } from "../../shared/contracts/session.ts";

export const session = signal<SessionDetail | null>(null);
