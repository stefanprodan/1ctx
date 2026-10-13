// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SendTotalsResponse } from "../../src/shared/api/admin.ts";
import { type ChatApp, idle } from "./chat.ts";

// once every send has ended, the agent's usage counts that many turns
export async function waitAgentSends(chat: ChatApp, sends: number) {
  await idle(chat.app);
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
  if (body.sends !== sends) {
    throw new Error(`expected ${sends} agent turns, counted ${body.sends}`);
  }
}
