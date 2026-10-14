// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the user's projects spent over the past seven days, as an aside
// section: the sessions, the turns and the tokens, once the route's load
// answers.

import { week } from "../../data/usage.ts";
import { count } from "../../lib/format.ts";
import { AsideLine, AsideSection } from "../../ui/Split.tsx";

export function WeekAside() {
  const spent = week.value;
  return (
    <AsideSection label="This week">
      {spent === null ? (
        <p class="split-empty">Loading</p>
      ) : (
        <>
          <AsideLine label="Sessions">{count(spent.sessions)}</AsideLine>
          <AsideLine label="Turns">{count(spent.sends)}</AsideLine>
          <AsideLine label="Tokens">
            {count(spent.promptTokens + spent.completionTokens)}
          </AsideLine>
        </>
      )}
    </AsideSection>
  );
}
