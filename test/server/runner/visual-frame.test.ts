// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  isVisualFrame,
  PROTOCOL,
  type VisualFrame,
} from "../../../src/shared/socket.ts";

const frame: VisualFrame = {
  type: "visual",
  sessionId: "session",
  sendId: "send",
  messageId: "reply",
  callIndex: 0,
  seq: 1,
  html: "<p>",
  htmlAt: 0,
};

describe("visual socket frames", () => {
  test("accepts the frame with an optional title and UTF-16 offsets", () => {
    expect(PROTOCOL).toBe(13);
    expect(isVisualFrame(frame)).toBe(true);
    expect(isVisualFrame({ ...frame, title: "Drawing", htmlAt: 5 })).toBe(true);
    expect(isVisualFrame({ ...frame, html: "", title: "Late" })).toBe(true);
  });

  test("rejects wrong shapes, extra fields and invalid indexes or offsets", () => {
    for (const value of [null, [], "", 1, {}, { ...frame, extra: true }]) {
      expect(isVisualFrame(value)).toBe(false);
    }
    for (const key of ["sessionId", "sendId", "messageId"] as const) {
      for (const value of ["", null, 4, undefined]) {
        expect(isVisualFrame({ ...frame, [key]: value })).toBe(false);
      }
    }
    for (const key of ["callIndex", "seq", "htmlAt"] as const) {
      for (const value of [
        -1,
        0.5,
        Infinity,
        NaN,
        "0",
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        expect(isVisualFrame({ ...frame, [key]: value })).toBe(false);
      }
    }
    expect(isVisualFrame({ ...frame, seq: 0 })).toBe(false);
    expect(isVisualFrame({ ...frame, title: null })).toBe(false);
    expect(isVisualFrame({ ...frame, html: null })).toBe(false);
    expect(isVisualFrame({ ...frame, type: "html" })).toBe(false);
  });
});
