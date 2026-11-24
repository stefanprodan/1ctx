// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the profile routes: the signed-in
// user's own page.

import type {
  AccessKey,
  AccessKeyDays,
  AccessKeyScope,
} from "../contracts/access-key.ts";
import type { Profile } from "../contracts/user.ts";

// GET /api/profile, and the answer of every write to it; emailOn says
// whether email is set up, so the page offers email from agents
export type ProfileResponse = { user: Profile; emailOn: boolean };

// PATCH /api/profile
export type UpdateProfileRequest = {
  fullName: string;
  about: string;
  tz: string;
};

// PUT /api/profile/email: whether agents and alerts may email the user
export type EmailSettingsRequest = { fromAgents: boolean };

// GET /api/profile/keys: the user's access keys, newest first, and the
// admin's cap on them; at 0 keys are off and /mcp answers 404
export type AccessKeysResponse = { keys: AccessKey[]; limit: number };

// POST /api/profile/keys: projectIds null reaches every project the
// user sees, now and later
export type CreateAccessKeyRequest = {
  name: string;
  scope: AccessKeyScope;
  projectIds: string[] | null;
  days: AccessKeyDays;
};

// the token is in this answer only, never again
export type CreateAccessKeyResponse = { key: AccessKey; token: string };

// DELETE /api/profile/keys/:id revokes one; 204

// one of the user's passkeys: its provider's name (device), the origin
// it was added at and signs in at, and its credential id, by which the
// page asks the browser to forget a removed one
export type Passkey = {
  id: string;
  credentialId: string;
  origin: string;
  device: string;
  createdAt: number;
  // null until it signs in
  lastUsedAt: number | null;
};

// GET /api/profile/passkeys: every passkey of the user, at every origin,
// oldest first
export type PasskeysResponse = { passkeys: Passkey[] };

type CredentialDescriptor = {
  type: "public-key";
  id: string;
  transports: string[];
};

// POST /api/profile/passkeys/options: the browser's create() options as
// PublicKeyCredentialCreationOptionsJSON; byte fields are base64url.
// excludeCredentials holds the user's passkeys of this host. A 409 at
// the cap
export type PasskeyCreationOptions = {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout: number;
  attestation: "none";
  authenticatorSelection: {
    residentKey: "required";
    requireResidentKey: true;
    userVerification: "required";
  };
  excludeCredentials: CredentialDescriptor[];
};

// POST /api/profile/passkeys: the new credential's toJSON(), answered
// 201 with its Passkey; a refused answer is a 400, a credential held
// already or the cap a 409
export type PasskeyRegistration = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    publicKey: string;
    publicKeyAlgorithm: number;
    transports?: string[];
  };
};
