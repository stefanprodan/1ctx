// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the credential routes, all for admins.

import type { CredentialSummary, HttpMethod } from "../contracts/credential.ts";

// a key file the form may pick: its name and whether its value passes
// the key's rule, never the value
export type CredentialKey = { name: string; usable: boolean };

// GET /api/credentials
export type CredentialsResponse = {
  credentials: CredentialSummary[];
  keys: CredentialKey[];
};

// POST /api/credentials and PATCH /api/credentials/:id answer the row
export type CredentialResponse = { credential: CredentialSummary };

// POST /api/credentials: methods default to GET and HEAD, projects to
// none
export type CreateCredentialRequest = {
  name: string;
  keyName: string;
  prefix: string;
  header: string;
  template: string;
  methods?: HttpMethod[];
  projectIds?: string[];
};

// PATCH /api/credentials/:id: any field but the name; a supplied list
// replaces the held one
export type PatchCredentialRequest = Partial<
  Omit<CreateCredentialRequest, "name">
>;
