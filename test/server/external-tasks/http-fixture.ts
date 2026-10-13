// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test";
import type { TaskKey } from "../../../src/server/external-tasks/index.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import type { ConnData } from "../../../src/server/web/socket.ts";
import type {
  CreateExternalTaskRequest,
  ExternalTaskResponse,
} from "../../../src/shared/api/external-tasks.ts";
import { createKey } from "../../helpers/access-keys.ts";
import {
  collectLogs,
  hashPassword,
  ORIGIN,
  type TestApp,
  type TestClient,
  testApp,
} from "../../helpers/app.ts";
import { createTeam } from "../../helpers/projects.ts";
import { recordingConn } from "../../helpers/socket.ts";

// a task's required brief: the project's brief.md, made once by the user
export function briefFile(
  app: { knowledge: TestApp["knowledge"] },
  projectId: string,
  userId: string,
): string {
  const held = app.knowledge.store.fileNamed(projectId, "brief.md");
  if (held !== null) return held.id;
  return app.knowledge.create(
    projectId,
    {
      kind: "user",
      id: userId,
      name: "user",
      sessionId: null,
      origin: null,
      keyName: null,
    },
    "brief.md",
    "# Brief",
  ).id;
}

export async function httpFixture() {
  const logs = collectLogs();
  const app = await testApp({ logFactory: logs.logFactory });
  const admin = app.client();
  expect((await admin.login("admin", "hunter2-test")).status).toBe(200);
  const passwordHash = await hashPassword("pw");
  const person = async (username: string) => {
    const user = app.createUser({
      username,
      fullName: username,
      email: `${username}@example.com`,
      role: "member",
      passwordHash,
      mustChangePassword: false,
      now: app.now.value,
    });
    const client = app.client();
    expect((await client.login(username, "pw")).status).toBe(200);
    return { user, client };
  };
  const creator = await person("creator");
  const member = await person("member");
  const outsider = await person("outsider");
  const project = await createTeam(admin, "external", [
    creator.user.id,
    member.user.id,
  ]);
  const projectId = project.id;
  const base = `/api/projects/${projectId}/external-tasks`;
  // a knowledge file of the project, by its id, made once
  const file = async (
    name: string,
    project = projectId,
    client = creator.client,
  ) => {
    const held = app.knowledge.store.fileNamed(project, name);
    if (held !== null) return held.id;
    const response = await client.call(
      "POST",
      `/api/projects/${project}/knowledge`,
      { body: { name, text: `# ${name}` } },
    );
    expect(response.status).toBe(201);
    return (await response.json()).file.id as string;
  };
  // the file every task links unless told otherwise
  const briefId = await file("brief.md");
  const create = async (
    fields: Partial<CreateExternalTaskRequest> = {},
    client = creator.client,
    project = projectId,
  ): Promise<ExternalTaskResponse> => {
    const response = await client.call(
      "POST",
      `/api/projects/${project}/external-tasks`,
      {
        body: {
          title: "Check the work",
          labels: ["build"],
          fileIds: [briefId],
          ...fields,
        },
      },
    );
    expect(response.status).toBe(201);
    return response.json();
  };
  const show = async (
    id: string,
    client = member.client,
    query = "",
  ): Promise<ExternalTaskResponse> => {
    const response = await client.call(
      "GET",
      `/api/external-tasks/${id}${query}`,
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  const key = async (name = "terminal"): Promise<TaskKey> => {
    const { key } = await createKey(creator.client, { name });
    return { userId: creator.user.id, keyId: key.id, keyName: key.name };
  };
  const limits = async (values: Partial<typeof DEFAULT_LIMITS>) => {
    const response = await admin.call("PUT", "/api/limits", {
      body: { values: { ...DEFAULT_LIMITS, ...values } },
    });
    expect(response.status).toBe(200);
  };
  const connect = async (client: TestClient) => {
    let data: ConnData | null = null;
    await app.handle(
      new Request(`${ORIGIN}/api/socket`, {
        headers: { cookie: client.cookie!, host: "1ctx.test", origin: ORIGIN },
      }),
      "127.0.0.1",
      (captured) => {
        data = captured as ConnData;
        return true;
      },
    );
    if (data === null) throw new Error("socket upgrade did not run");
    const conn = recordingConn(data);
    app.socket.open(conn);
    return conn;
  };
  return {
    app,
    admin,
    creator,
    member,
    outsider,
    projectId,
    base,
    file,
    briefId,
    create,
    show,
    key,
    limits,
    connect,
    logs,
    async [Symbol.asyncDispose]() {
      await app.shutdown();
      app.db.close();
    },
  };
}
