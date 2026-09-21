// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one socket of the tab: open while someone is signed in, closed
// when nobody is. It carries nothing the entities could not fetch: on
// every open the page's load runs again and the session on screen is
// watched again, so a reconnect reconciles the way a navigation does,
// and a frame lost while the socket was down costs nothing. The frames
// go to whoever registered for them, so this module knows no entity.

import { effect } from "@preact/signals";
import { PROTOCOL, type SocketEvent } from "../../shared/socket.ts";
import { me, setMe } from "./me.ts";

// the connection's access is gone: no reconnect
export const CLOSE_REVOKED = 4001;
// the server is restarting: one quick retry before the backoff
export const CLOSE_RESTARTING = 1012;
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
export const RESTART_RETRY_MS = 2000;

// what the module needs of a WebSocket, so a test passes a fake
export type Wire = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type SocketDeps = {
  connect(): Wire;
  reloadPage(): void;
  // the page's load again, after every open
  reload(): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
};

type Dispatch = (event: SocketEvent) => void;

const OPEN = 1;

let deps: SocketDeps = {
  connect: () =>
    new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/socket`,
    ) as unknown as Wire,
  reloadPage: () => location.reload(),
  reload: () => Promise.resolve(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
let dispatchers: Dispatch[] = [];
let wire: Wire | null = null;
let timer: unknown = null;
let attempt = 0;
let watching: string | null = null;
let stopped = false;
// the server build this tab first heard from, which shipped its client
let build: string | null = null;

export function onSocketEvent(fn: Dispatch): () => void {
  dispatchers = [...dispatchers, fn];
  return () => {
    dispatchers = dispatchers.filter((d) => d !== fn);
  };
}

const isEvent = (value: unknown): value is SocketEvent =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

function send(command: object): void {
  if (wire !== null && wire.readyState === OPEN) {
    wire.send(JSON.stringify(command));
  }
}

// the session the page wants frames for; null when it leaves. Sent now
// when the socket is open, and again on every open
export function watch(sessionId: string | null): void {
  const before = watching;
  watching = sessionId;
  if (sessionId !== null) send({ type: "watch", sessionId });
  else if (before !== null) send({ type: "unwatch", sessionId: before });
}

export function watched(): string | null {
  return watching;
}

function clearTimer(): void {
  if (timer !== null) deps.clearTimer(timer);
  timer = null;
}

function schedule(ms: number): void {
  clearTimer();
  timer = deps.setTimer(() => {
    timer = null;
    connect();
  }, ms);
}

function connect(): void {
  if (stopped || wire !== null) return;
  const ws = deps.connect();
  wire = ws;
  ws.onopen = null;
  ws.onerror = null;
  ws.onmessage = (ev) => {
    if (wire !== ws) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (!isEvent(parsed)) return;
    if (parsed.type === "hello") {
      // another protocol, or another build than the one this tab came
      // from: the server was deployed over an open tab, whose client may
      // no longer match the API
      const moved = build !== null && build !== parsed.version;
      if (parsed.protocol !== PROTOCOL || moved) {
        deps.reloadPage();
        return;
      }
      build = parsed.version;
      attempt = 0;
      if (watching !== null) send({ type: "watch", sessionId: watching });
      void deps.reload();
    }
    // the user's own row, like the revocation below: the loaders and
    // the rail follow me, so the new role opens or closes what it may
    if (parsed.type === "role" && me.value && me.value.role !== parsed.role) {
      setMe({ ...me.value, role: parsed.role });
    }
    for (const d of dispatchers) d(parsed);
  };
  ws.onclose = (ev) => {
    if (wire !== ws) return;
    wire = null;
    if (stopped) return;
    // the login behind the tab is gone: a reset, a disable, a sign out
    // elsewhere. Drop the user now rather than at the next 401, so the
    // tab shows the sign-in form and not a page it may no longer see
    if (ev.code === CLOSE_REVOKED) {
      if (me.value) setMe(null);
      return;
    }
    if (ev.code === CLOSE_RESTARTING && attempt === 0) {
      attempt = 1;
      schedule(RESTART_RETRY_MS);
      return;
    }
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
    attempt = Math.min(attempt + 1, 30);
    schedule(wait);
  };
}

function disconnect(): void {
  clearTimer();
  attempt = 0;
  const ws = wire;
  wire = null;
  ws?.close();
}

// the socket follows the signed-in user; the effect is what a test
// disposes, and the override is how it passes a fake wire
export function startSocket(override?: Partial<SocketDeps>): () => void {
  if (override) deps = { ...deps, ...override };
  stopped = false;
  const dispose = effect(() => {
    if (me.value) connect();
    else disconnect();
  });
  return () => {
    stopped = true;
    dispose();
    disconnect();
    watching = null;
    build = null;
  };
}

// the socket's state for a test
export function socketState(): { open: boolean; attempt: number } {
  return { open: wire !== null && wire.readyState === OPEN, attempt };
}
