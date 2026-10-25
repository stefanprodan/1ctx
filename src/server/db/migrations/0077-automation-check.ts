// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// An automation's check URL and its state. check_alert_at outlives a
// dismiss. Added columns only, so no row is copied.
export const m0077: Migration = {
  id: "0077-automation-check",
  up(db) {
    db.exec(`
      alter table automations add column check_url text;
      alter table automations add column check_etag text;
      alter table automations add column check_last_modified text;
      alter table automations add column check_body_hash text;
      alter table automations add column last_checked_at integer;
      alter table automations add column last_check_result text;
      alter table automations add column last_answered_at integer;
      alter table automations add column check_alert_at integer;
    `);
  },
};
