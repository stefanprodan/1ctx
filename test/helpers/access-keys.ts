// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test";
import type {
  CreateAccessKeyRequest,
  CreateAccessKeyResponse,
} from "../../src/shared/api/profile.ts";
import type { TestClient } from "./app.ts";

export const KEY_REQUEST: CreateAccessKeyRequest = {
  name: "terminal",
  scope: "write",
  projectIds: null,
  days: 30,
};

export async function createKey(
  client: TestClient,
  fields: Partial<CreateAccessKeyRequest> = {},
): Promise<CreateAccessKeyResponse> {
  const res = await client.call("POST", "/api/profile/keys", {
    body: { ...KEY_REQUEST, ...fields },
  });
  expect(res.status).toBe(201);
  return res.json();
}
