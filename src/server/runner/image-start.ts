// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../../shared/contracts/session.ts";
import { BadRequest } from "../lib/errors.ts";
import { unfitImages } from "./image-fit.ts";
import { buildRequest, type RoundDeps } from "./round.ts";
import type { ActiveSend } from "./send.ts";

// the start's check, in its transaction: the first request as the round
// will build it, the turn's rows written and its images claimed, so a
// refusal rolls them back and the images stay staged
export const refuseUnfit =
  (
    deps: Pick<RoundDeps, "lookups" | "clock">,
    historyOf: (send: ActiveSend) => Message[],
  ) =>
  (send: ActiveSend, fresh: number): void => {
    const req = buildRequest(send, historyOf(send), deps.lookups, deps.clock());
    const unfit = unfitImages(req, send.policy, fresh);
    if (unfit !== null) throw new BadRequest(unfit);
  };
