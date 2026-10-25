// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A scheduled task's check URL, asked before each scheduled run: the
// validators and body hash of the answer that started its last run, the
// last check and its result, the last check that answered, and when a
// failed check opened or joined the open alert, kept while dismissed.
// Added columns only, so no row is copied.
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
