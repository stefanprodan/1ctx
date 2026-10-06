// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the mail routes, all for admins.

import type {
  MailFailure,
  MailSecurity,
  MailSettings,
} from "../contracts/mail.ts";

// GET /api/admin/mail, and what PUT answers: the settings, null until
// saved; enabled once saved with the key file it names present; the
// email- key files to pick from; the signed-in admin's address, null
// while it is a placeholder, which Send test mails
export type MailResponse = {
  settings: MailSettings | null;
  enabled: boolean;
  hasKey: boolean;
  keys: string[];
  to: string | null;
};

// PUT /api/admin/mail: every field. username and keyName are both set
// or both null; publicAddress is an https:// origin, http:// only for
// a loopback host, and is kept without a path
export type PutMailRequest = {
  host: string;
  port: number;
  security: MailSecurity;
  username: string | null;
  keyName: string | null;
  fromAddress: string;
  fromName: string;
  publicAddress: string;
};

// POST /api/admin/mail/test: sent now to the signed-in admin, never
// queued; 409 while mail is off or the admin's address is a placeholder
export type MailTestResponse = { result: "sent" | MailFailure };
