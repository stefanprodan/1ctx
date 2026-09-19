// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { WebSnapshot } from "../../shared/web.ts";

export function domainWords(web: WebSnapshot): string {
  const first = web.domains.slice(0, 10).join(", ");
  return web.domains.length > 10
    ? `${first} and ${web.domains.length - 10} more`
    : first;
}
