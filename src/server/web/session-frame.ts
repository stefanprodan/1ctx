// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { EnvelopeRow } from "../../shared/api/sessions.ts";
import type { ChannelMeter } from "../../shared/contracts/session.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import type { BusEvent } from "../lib/bus.ts";
import { errorFields, type Log } from "../lib/log.ts";

type MeterDeps = {
  channelMeter(id: string): ChannelMeter | null;
  log: Log;
};

export function channelMeterOf(
  deps: MeterDeps,
  sessionId: string,
): ChannelMeter | null {
  try {
    return deps.channelMeter(sessionId);
  } catch (err) {
    deps.log.error("channel meter failed", {
      chat: sessionId,
      ...errorFields(err),
    });
    return null;
  }
}

export function sessionFrame(
  event: Extract<BusEvent, { type: "session.changed" }>,
  deps: MeterDeps & {
    envelopeRow(id: string): EnvelopeRow | null;
  },
): Extract<SocketEvent, { type: "session" }> {
  const { session, send, messages, messagesCut } = event.data;
  // A failed read still sends the rows the open session needs.
  let row: EnvelopeRow | null = null;
  try {
    row = deps.envelopeRow(session.id);
  } catch (err) {
    deps.log.error("envelope row failed", {
      chat: session.id,
      ...errorFields(err),
    });
  }
  const meter =
    session.origin === "channel" &&
    send !== null &&
    (send.status !== "running" ||
      messagesCut ||
      messages.some((row) => row.kind === "user"))
      ? channelMeterOf(deps, session.id)
      : null;
  return {
    type: "session",
    ...event.data,
    row,
    ...(meter === null ? {} : { channelContext: meter }),
  };
}
