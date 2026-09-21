// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The CLI-only service area: `1ctx service` installs the binary with the
// platform's service manager. It composes nothing and opens no database.

export type {
  ServiceBackend,
  ServiceDefinition,
  ServiceState,
} from "./backend.ts";
export { runService, type ServiceDeps, ServiceError } from "./service.ts";
