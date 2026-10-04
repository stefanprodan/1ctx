// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The server's API as the driver calls it: one signed-in user per
// cookie, every write with the origin header, every answer timed.

import type { LoginResponse } from "../../../src/shared/api/access.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";
import { info, sleep } from "./log.ts";

export type Who = { user: string; cookie: string; id: string; role: string };
export type Res<T> = { status: number; body: T; ms: number; error: string };

export type ApiOptions = {
  base: string;
  // one password for every user (a local run), else <secrets>user-<name>.key
  password?: string;
  secrets?: string;
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

  private async password(user: string): Promise<string> {
    if (this.options.password !== undefined) return this.options.password;
    const dir = this.options.secrets ?? "/secrets/";
    return (await Bun.file(`${dir}user-${user}.key`).text()).trim();
  }

  // Sign-in is limited per client address. The server runs with
  // --trust-proxy, so each user signs in from its own forwarded
  // address; a 429 waits the window out and tries again.
  async signIn(user: string, index: number): Promise<Who> {
    const password = await this.password(user);
    const addr = `10.${200 + ((index >> 16) & 0x3f)}.${(index >> 8) & 0xff}.${index & 0xff}`;
    for (let attempt = 0; ; attempt++) {
      const t = performance.now();
      const r = await fetch(`${this.base}/api/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: this.base,
          "x-forwarded-for": addr,
        },
        body: JSON.stringify({ username: user, password }),
      });
      if (r.status === 429 && attempt < 10) {
        await r.text();
        info("login limited, waiting", { user });
        await sleep(61_000);
        continue;
      }
      if (r.status !== 200) {
        throw new Error(`${user} sign in: ${r.status} ${await r.text()}`);
      }
      const body = (await r.json()) as LoginResponse;
      const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
      this.loginMs.push(performance.now() - t);
      return { user, cookie, id: body.user.id, role: body.user.role };
    }
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
