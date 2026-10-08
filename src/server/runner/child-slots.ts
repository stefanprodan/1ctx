// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A send's subagents and where each runs (docs/subagents.md). The
// parent streams nothing while it waits on a delegate call, so its
// first running child runs in its place, uncounted; each other one at
// the same time holds an extra stream of the registry's, which counts
// under sendsRunning. A child with no place waits for a sibling to end.
// Every count moves synchronously, so a round's parallel calls take
// their places in call order and never race.

export type Children = {
  // started in all, refused past childrenPerSend
  started: number;
  // the folders of the parent's /tmp its children's files return to
  folders: Set<string>;
  // running now, at most childrenAtOnce
  running: number;
  // one of them runs in the parent's place
  inPlace: boolean;
  // the calls waiting for a place, first come first served
  waiting: ((slot: Slot) => void)[];
};

// an extra slot is the registry's, given back when the child ends
export type Slot = { extra: boolean };

export type SlotPort = {
  atOnce: number;
  // an extra stream, when sendsRunning has room for one
  takeExtra(): boolean;
  freeExtra(): void;
  // a freed extra may admit a queued send, once the waiters had it first
  wake(): void;
};

export const noChildren = (): Children => ({
  started: 0,
  folders: new Set(),
  running: 0,
  inPlace: false,
  waiting: [],
});

function place(children: Children, port: SlotPort): Slot | null {
  if (children.running >= port.atOnce) return null;
  if (!children.inPlace) {
    children.inPlace = true;
    children.running++;
    return { extra: false };
  }
  if (!port.takeExtra()) return null;
  children.running++;
  return { extra: true };
}

// a place now or once a sibling ends; null when the signal ended the
// wait first. The place is taken before this returns its promise
export function takeSlot(
  children: Children,
  port: SlotPort,
  signal: AbortSignal,
): Promise<Slot | null> {
  if (signal.aborted) return Promise.resolve(null);
  const now = children.waiting.length === 0 ? place(children, port) : null;
  if (now !== null) return Promise.resolve(now);
  return new Promise((resolve) => {
    const waiter = (slot: Slot) => {
      signal.removeEventListener("abort", gone);
      resolve(slot);
    };
    const gone = () => {
      const at = children.waiting.indexOf(waiter);
      if (at >= 0) children.waiting.splice(at, 1);
      resolve(null);
    };
    signal.addEventListener("abort", gone, { once: true });
    children.waiting.push(waiter);
  });
}

// the place let go, and the next waiters placed while there is room
export function freeSlot(children: Children, slot: Slot, port: SlotPort): void {
  children.running--;
  if (slot.extra) port.freeExtra();
  else children.inPlace = false;
  while (children.waiting.length > 0) {
    const next = place(children, port);
    if (next === null) break;
    children.waiting.shift()!(next);
  }
  if (slot.extra) port.wake();
}
