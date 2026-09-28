// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SendTotalsResponse } from "../../src/shared/api/admin.ts";
import { type ChatApp, tick } from "./chat.ts";

export async function waitAgentSends(chat: ChatApp, sends: number) {
  let counted = 0;
  for (let i = 0; i < 50; i++) {
    // The window excludes its upper bound, including a row stamped now.
    chat.app.now.value += 1;
    const response = await chat.admin.call(
      "GET",
      `/api/agents/${chat.agentId}/usage`,
    );
    if (response.status !== 200) {
      throw new Error(
        `agent usage answered ${response.status}: ${await response.text()}`,
      );
    }
    const body: SendTotalsResponse = await response.json();
    counted = body.sends;
    if (counted === sends) return;
    if (counted > sends) break;
    await tick();
  }
  throw new Error(`expected ${sends} agent turns, counted ${counted}`);
}
