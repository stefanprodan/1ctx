// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The ordered list. A migration is appended, never edited, once a schema
// has shipped; while alpha the last one may be rewritten and the preview
// db wiped.

import type { Migration } from "../migration.ts";
import { m0001 } from "./0001-users-logins.ts";

export const MIGRATIONS: Migration[] = [m0001];
