// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { hostWords } from "../../shared/sandbox-net.ts";
import type { WebSnapshot } from "../../shared/web.ts";

export const domainWords = (web: WebSnapshot): string => hostWords(web.domains);
