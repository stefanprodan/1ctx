// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The post-commit notification bus. Events are hints: a subscriber reads
// rows when it needs the truth, no command travels here, and nothing
// durable is maintained from a listener. transact() is the only
// publisher of durable changes; it publishes after commit.

// the event map: one entry per event, payload by name
export type BusEvents = {
  // a user's logins were revoked (logout, or a later password change);
  // the socket layer closes that user's connections
  "login.revoked": { userId: string; loginId: string | null };
};

export type BusEvent = {
  [K in keyof BusEvents]: { type: K; data: BusEvents[K] };
}[keyof BusEvents];

type Listener = (event: BusEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// a listener that throws is a bug in the listener, not in the publisher;
// it is reported and the others still run
export function publish(event: BusEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error(`bus: listener failed on ${event.type}: ${String(err)}`);
    }
  }
}
