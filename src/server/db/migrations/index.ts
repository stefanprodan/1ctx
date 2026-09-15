// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The ordered list. New tables, columns and indexes are a migration
// appended here. A rename or a retype rewrites the migration that made
// the thing and wipes the preview db; alpha owes no compatibility.

import type { Migration } from "../migration.ts";
import { m0001 } from "./0001-init.ts";
import { m0002 } from "./0002-usage-activity.ts";
import { m0003 } from "./0003-automations.ts";
import { m0004 } from "./0004-run-source.ts";
import { m0005 } from "./0005-suspended-by.ts";
import { m0006 } from "./0006-skills.ts";
import { m0007 } from "./0007-user-tz.ts";

export const MIGRATIONS: Migration[] = [
  m0001,
  m0002,
  m0003,
  m0004,
  m0005,
  m0006,
  m0007,
];
