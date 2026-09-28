// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { ago, sentence } from "../../lib/format.ts";

// "Timed out. Last refresh 3d ago."
export const refreshLine = (error: string, at: number, now: number): string =>
  `${sentence(error)} Last refresh ${ago(at, now)}.`;
