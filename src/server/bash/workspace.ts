// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SessionOrigin } from "../../shared/words.ts";

export type Workspace = {
  id: string;
  sessionId: string;
};

export const sessionWorkspace = (sessionId: string): Workspace => ({
  id: sessionId,
  sessionId,
});

export const workspaceOf = (
  sessionId: string,
  origin: SessionOrigin,
  agentId: string,
): Workspace =>
  origin === "channel"
    ? { id: `${sessionId}:${agentId}`, sessionId }
    : sessionWorkspace(sessionId);

export const workspaceId = (workspace: Workspace): string => workspace.id;

export const workspaceSession = (workspace: Workspace): string =>
  workspace.sessionId;
