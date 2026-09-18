// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { AgentStore } from "../../../src/server/agents/index.ts";
import { knowledgeArea } from "../../../src/server/knowledge/index.ts";
import { NotFound } from "../../../src/server/lib/errors.ts";
import { silent } from "../../../src/server/lib/log.ts";
import {
  DEFAULT_LIMITS,
  type KnowledgeCaps,
} from "../../../src/server/limits/index.ts";
import { ProjectStore } from "../../../src/server/projects/index.ts";
import { ProviderStore } from "../../../src/server/providers/index.ts";
import { SessionStore } from "../../../src/server/sessions/index.ts";
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
  const providers = new ProviderStore(db);
  const provider = providers.create({
    name: "local",
    wire: "openai-compatible",
    baseUrl: "http://models.test/v1",
    keyName: null,
    now: now.value,
  });
  const agents = new AgentStore(
    db,
    () => [],
    () => [],
  );
  const coder = agents.create({
    name: "coder",
    avatar: "bot",
    providerId: provider.id,
    model: {
      id: "test-model",
      name: "Test model",
      contextLength: null,
      promptPrice: null,
      completionPrice: null,
      tools: true,
      reasoning: false,
    },
    thinking: null,
    effort: null,
    prompt: "",
    skills: [],
    servers: [],
    mcpMode: "auto",
    now: now.value,
  });
  const sessions = new SessionStore(db, {
    latest: () => null,
    latestFor: () => new Map(),
    deleteSession: () => 0,
  });
  const makeSession = () =>
    sessions.create({
      projectId,
      ownerId: user.id,
      agentId: coder.id,
      title: "Knowledge chat",
      status: "done",
      now: now.value,
    });
  const session = makeSession();
  const author: KnowledgeAuthor = {
    kind: "user",
    id: user.id,
    name: user.username,
    sessionId: null,
    origin: null,
  };
  const agent: KnowledgeAuthor = {
    kind: "agent",
    id: coder.id,
    name: coder.name,
    sessionId: session.id,
    origin: "chat",
  };
  const caps = { ...DEFAULT_LIMITS, ...overrides };
  const area = knowledgeArea({
    db,
    clock: () => now.value,
    limits: { current: () => caps },
    access: {
      project(_principal, id) {
        const project = projects.byId(id);
        if (project === null) throw new NotFound();
        return project;
      },
    },
  });
  return {
    db,
    area,
    projectId,
    author,
    agent,
    now,
    caps,
    session,
    sessions,
    makeSession,
  };
}
