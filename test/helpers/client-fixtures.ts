// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AdminUser } from "../../src/shared/api/users.ts";
import type { DeciderSummary } from "../../src/shared/contracts/decider.ts";
import type { ProviderSummary } from "../../src/shared/contracts/provider.ts";
import type { Me } from "../../src/shared/contracts/user.ts";

export const admin = (over: Partial<Me> = {}): Me => ({
  id: "u1",
  username: "admin",
  fullName: "Stefan Prodan",
  role: "admin",
  mustChangePassword: false,
  ...over,
});

export const user = (over: Partial<AdminUser> = {}): AdminUser => ({
  ...admin(),
  email: "admin@example.test",
  tz: "UTC",
  createdAt: new Date(2026, 8, 12).getTime(),
  disabled: false,
  emailPlaceholder: false,
  lastVisitDay: null,
  projectIds: [],
  ...over,
});

export const provider = (
  over: Partial<ProviderSummary> = {},
): ProviderSummary => ({
  id: "pr1",
  name: "router",
  wire: "openrouter",
  baseUrl: "http://models.test/v1",
  keyName: "provider-router",
  hasKey: false,
  createdAt: 0,
  ...over,
});

export const decider = (
  over: Partial<DeciderSummary> = {},
): DeciderSummary => ({
  id: "d1",
  name: "judge",
  providerId: "pr1",
  model: "vendor/judge-1",
  contextLength: 32_000,
  promptPrice: 0.04,
  default: true,
  createdAt: 0,
  ...over,
});
