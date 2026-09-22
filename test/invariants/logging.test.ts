// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { collectLogs, testApp } from "../helpers/app.ts";

const secrets = {
  "provider-one": "provider-private-value",
  "search-one": "search-private-value",
  "mcp-one": "mcp-private-value",
};

test("error events scrub current keys, URL secrets and causes", async () => {
  const logs = collectLogs();
  const app = await testApp({ secrets, logFactory: logs.logFactory });
  const client = app.client();
  expect((await client.login("admin", "hunter2-test")).status).toBe(200);
  const original = app.users.setDisabled.bind(app.users);
  app.users.setDisabled = () => {
    const error = new Error(
      `failed ${Object.values(secrets).join(" ")} https://user:pass@fault.test/path?q=query-private\nsecond-private`,
    );
    error.cause = new Error("cause-private");
    throw error;
  };
  try {
    const response = await client.call("POST", "/api/users", {
      body: {
        username: "robin",
        fullName: "Robin",
        email: "robin@example.test",
        tz: "UTC",
        role: "member",
        password: "longenough",
        disabled: true,
      },
    });
    expect(response.status).toBe(500);
  } finally {
    app.users.setDisabled = original;
  }
  const event = logs.events.findLast((entry) => entry.level === "error")!;
  expect(event).toMatchObject({
    area: "router",
    msg: "request",
    fields: {
      route: "/api/users",
      status: 500,
      error: "failed [key] [key] [key] https://fault.test/path",
    },
  });
  const rendered = JSON.stringify(event);
  for (const value of Object.values(secrets))
    expect(rendered).not.toContain(value);
  expect(rendered).not.toContain("query-private");
  expect(rendered).not.toContain("second-private");
  expect(rendered).not.toContain("cause-private");
  expect(rendered).not.toContain("user:pass");
});
