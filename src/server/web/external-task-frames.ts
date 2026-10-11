// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SocketEvent } from "../../shared/socket.ts";
import type { BusEvent } from "../lib/bus.ts";

export function externalTaskFrame(
  event: BusEvent,
  toProject: (projectId: string, frame: () => SocketEvent) => void,
): boolean {
  switch (event.type) {
    case "externalTask.changed":
      toProject(event.data.projectId, () => ({
        type: "externalTask",
        ...event.data,
      }));
      return true;
    case "externalTask.deleted":
      toProject(event.data.projectId, () => ({
        type: "externalTaskDeleted",
        ...event.data,
      }));
      return true;
    default:
      return false;
  }
}
