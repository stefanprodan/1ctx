// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { knowledgeArea } from "../../../src/server/knowledge/index.ts";
import { silent } from "../../../src/server/lib/log.ts";
import {
  DEFAULT_LIMITS,
  type KnowledgeCaps,
} from "../../../src/server/limits/index.ts";
import { ProjectStore } from "../../../src/server/projects/index.ts";
import { usersArea } from "../../../src/server/users/index.ts";
import type { KnowledgeAuthor } from "../../../src/shared/contracts/knowledge.ts";
import { memoryDb } from "../../helpers/db.ts";

export function setup(overrides: Partial<KnowledgeCaps> = {}) {
  const db = memoryDb();
  const now = { value: 100 };
  const projects = new ProjectStore(db);
  const users = usersArea({
    db,
    clock: () => now.value,
    secret: () => null,
    log: silent,
    projects: {
      createPersonal: ({ userId, now }) =>
        projects.createPersonal({ userId, now }),
    },
  });
  const user = users.createUser({
    username: "writer",
    fullName: "Writer",
    email: "writer@example.com",
    role: "member",
    passwordHash: "unused",
    mustChangePassword: false,
    now: 0,
  });
  const projectId = projects.personal(user.id)!.id;
  const author: KnowledgeAuthor = {
    kind: "user",
    id: user.id,
    name: user.username,
    sessionId: null,
    origin: null,
  };
  const agent: KnowledgeAuthor = {
    kind: "agent",
    id: "gone-agent",
    name: "coder",
    sessionId: "gone-session",
    origin: "chat",
  };
  const caps = { ...DEFAULT_LIMITS, ...overrides };
  const area = knowledgeArea({
    db,
    clock: () => now.value,
    limits: { current: () => caps },
  });
  return { db, area, projectId, author, agent, now, caps };
}
