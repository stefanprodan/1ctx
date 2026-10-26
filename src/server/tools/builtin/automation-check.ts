// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// show's Check URL line: the URL without its query, which may hold a
// key, and what the last check found.

import {
  type AutomationSummary,
  isCheckQuiet,
} from "../../../shared/contracts/automation.ts";

export function checkText(
  a: AutomationSummary,
  time: (ms: number) => string,
): string {
  if (a.checkUrl === null) return "none, it runs on every fire";
  const url = URL.parse(a.checkUrl);
  const shown =
    url === null
      ? "set"
      : `${url.origin}${url.pathname}${url.search === "" ? "" : " (query not shown)"}`;
  const result = a.lastCheckResult;
  const last =
    a.lastCheckedAt === null || result === null
      ? "not checked yet"
      : `checked ${time(a.lastCheckedAt)}: ${
          result === "200"
            ? "new answer, a run started"
            : isCheckQuiet(result)
              ? "nothing new"
              : `failed, ${result}`
        }`;
  const compare =
    a.checkCompare === null ? "" : `, compares only ${a.checkCompare}`;
  return `${shown}, asked at every scheduled time, runs only on a new answer${compare}; ${last}`;
}
