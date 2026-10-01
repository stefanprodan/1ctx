// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// a rebuild that names its tables copies every row with its key, so only
// they are checked; naming them without `rebuild` would drop with keys on
export type Migration = {
  id: string;
  up: (db: Database) => void;
} & (
  | { rebuild?: undefined; rebuilds?: undefined }
  | { rebuild: true; rebuilds?: readonly string[] }
);
