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

export const MIGRATIONS: Migration[] = [m0001, m0002, m0003];
