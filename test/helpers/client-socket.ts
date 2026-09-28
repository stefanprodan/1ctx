// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Wire } from "../../src/client/data/socket.ts";

export class FakeWire implements Wire {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.closed = true;
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  fireClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
