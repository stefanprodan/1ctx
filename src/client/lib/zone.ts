// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// the zone this browser's clock is in, "Europe/Bucharest"
export const browserZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;
