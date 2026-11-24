// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The server's API as the driver calls it: one signed-in user per
// cookie, every write with the origin header, every answer timed.

import type { MeResponse } from "../../../src/shared/api/access.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";

export type Who = { user: string; cookie: string; id: string; role: string };
export type Res<T> = { status: number; body: T; ms: number; error: string };

export type ApiOptions = {
  base: string;
  // a JSON file of login tokens by username, minted for this run
  logins: string;
};

export class Api {
  readonly base: string;
  readonly socketUrl: string;
  readonly loginMs: number[] = [];

  constructor(private readonly options: ApiOptions) {
    this.base = options.base.replace(/\/$/, "");
    this.socketUrl = `${this.base.replace(/^http/, "ws")}/api/socket`;
  }

  async call<T>(
    who: Who | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Res<T>> {
    const t = performance.now();
    try {
      const r = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          origin: this.base,
          ...(who ? { cookie: who.cookie } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await r.text();
      let parsed: unknown = null;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {}
      const error = r.ok
        ? ""
        : ((parsed as { error?: string } | null)?.error ?? text.slice(0, 200));
      return {
        status: r.status,
        body: parsed as T,
        ms: performance.now() - t,
        error,
      };
    } catch (e) {
      const error = String(e).slice(0, 200);
      return { status: 0, body: null as T, ms: performance.now() - t, error };
    }
  }

  // a 2xx body or a thrown error, for the calls a run cannot do without
  async must<T>(who: Who, method: string, path: string, body?: unknown) {
    const r = await this.call<T>(who, method, path, body);
    if (r.status < 200 || r.status > 299) {
      throw new Error(`${method} ${path}: ${r.status} ${r.error}`);
    }
    return r.body;
  }

  private tokens: Promise<Record<string, string>> | null = null;

  // A user's minted login as the cookie, checked by reading who it is.
  // Nothing signs in: the tokens were opened in the database before the
  // server started.
  async signIn(user: string): Promise<Who> {
    this.tokens ??= Bun.file(this.options.logins).json();
    const token = (await this.tokens)[user];
    if (token === undefined) throw new Error(`no login minted for ${user}`);
    const cookie = `login=${token}`;
    const t = performance.now();
    const r = await this.call<MeResponse>(
      { user, cookie, id: "", role: "" },
      "GET",
      "/api/me",
    );
    if (r.status !== 200 || r.body?.user?.username !== user) {
      throw new Error(`${user} login: ${r.status} ${r.error || "nobody"}`);
    }
    this.loginMs.push(performance.now() - t);
    return { user, cookie, id: r.body.user.id, role: r.body.user.role };
  }

  socket(
    who: Who,
    onFrame: (ev: SocketEvent, raw: string) => void,
    onClose: (code: number) => void,
  ): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.socketUrl, {
        headers: { cookie: who.cookie, origin: this.base },
      } as unknown as string[]);
      ws.onopen = () => resolve(ws);
      ws.onerror = (e) =>
        reject(
          new Error(
            `socket ${who.user}: ${String((e as ErrorEvent).message ?? e)}`,
          ),
        );
      ws.onclose = (e) => onClose(e.code);
      ws.onmessage = (m) => {
        const raw = String(m.data);
        onFrame(JSON.parse(raw) as SocketEvent, raw);
      };
    });
  }
}
