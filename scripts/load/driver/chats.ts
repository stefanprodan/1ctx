// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Starting a chat and following one up, as both targets' load does: a
// `post` event per turn started, a `refused` event, by cap, per turn
// the server turned away.

import type {
  QueuedResponse,
  SessionResponse,
} from "../../../src/shared/api/sessions.ts";
import type { Api, Res, Who } from "./api.ts";
import { now, out } from "./log.ts";

// which send cap a 429 names
export const capOf = (error: string) =>
  /^You have .* going/.test(error)
    ? "user"
    : /^This project has/.test(error)
      ? "project"
      : /^Too many chats and runs/.test(error)
        ? "process"
        : /waiting/.test(error)
          ? "queue"
          : "other";

export type Started = { session: string; send: string | null };

export class Poster {
  readonly refused: Record<string, number> = {};
  posts = 0;

  constructor(
    private readonly api: Api,
    readonly step: number,
  ) {}

  refuse(kind: string, user: string, marker: string, r: Res<unknown>) {
    const cap = r.status === 429 ? capOf(r.error) : `http${r.status}`;
    const key = `${kind}:${cap}`;
    this.refused[key] = (this.refused[key] ?? 0) + 1;
    out({
      t: "refused",
      at: now(),
      step: this.step,
      kind,
      user,
      marker,
      status: r.status,
      cap,
      error: r.error,
    });
  }

  posted(
    marker: string,
    user: string,
    kind: string,
    at: number,
    r: Res<unknown>,
  ) {
    this.posts++;
    out({
      t: "post",
      at,
      marker,
      user,
      kind,
      step: this.step,
      status: r.status,
      ms: Math.round(r.ms),
    });
  }

  async start(
    who: Who,
    projectId: string,
    agentId: string,
    kind: string,
    marker: string,
    text: string,
  ): Promise<Started | null> {
    const at = now();
    const r = await this.api.call<SessionResponse>(
      who,
      "POST",
      "/api/sessions",
      {
        projectId,
        agentId,
        message: `#${marker} ${text}`,
      },
    );
    if (r.status !== 201) {
      this.refuse(kind, who.user, marker, r);
      return null;
    }
    this.posted(marker, who.user, kind, at, r);
    return { session: r.body.session.id, send: r.body.send?.id ?? null };
  }

  // a follow-up: its send, null when it queued behind a running turn,
  // undefined when it was refused
  async followUp(
    who: Who,
    sessionId: string,
    kind: string,
    marker: string,
    text: string,
  ): Promise<string | null | undefined> {
    const at = now();
    const r = await this.api.call<SessionResponse | QueuedResponse>(
      who,
      "POST",
      `/api/sessions/${sessionId}/messages`,
      { message: `#${marker} ${text}` },
    );
    if (r.status !== 201 && r.status !== 202) {
      this.refuse(kind, who.user, marker, r);
      return undefined;
    }
    this.posted(marker, who.user, kind, at, r);
    return r.status === 201
      ? ((r.body as SessionResponse).send?.id ?? null)
      : null;
  }
}
