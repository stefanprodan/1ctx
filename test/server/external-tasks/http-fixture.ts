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
  type TestClient,
  testApp,
} from "../../helpers/app.ts";
import { createTeam } from "../../helpers/projects.ts";
import { recordingConn } from "../../helpers/socket.ts";

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
          text: "Read the brief.",
          fileIds: [],
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
