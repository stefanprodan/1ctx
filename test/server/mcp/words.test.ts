// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A request that never reached the server is one plain line, whatever
// the runtime and the SDK wrapped it in.

import { describe, expect, test } from "bun:test";
import { connectionFailed } from "../../../src/server/mcp/client.ts";

describe("connection failures", () => {
  test("are seen through the SDK's wrapping and the runtime's codes", () => {
    const refused = Object.assign(new Error("connect failed"), {
      code: "ECONNREFUSED",
    });
    expect(connectionFailed(refused)).toBe(true);
    expect(
      connectionFailed(
        new Error("Version negotiation probe failed: connect failed", {
          cause: refused,
        }),
      ),
    ).toBe(true);
    expect(
      connectionFailed(
        new Error(
          "Version negotiation probe failed: Unable to connect. Is the computer able to access the url?",
        ),
      ),
    ).toBe(true);
    expect(connectionFailed(new TypeError("fetch failed"))).toBe(true);
    expect(connectionFailed(new Error("the server answered 500"))).toBe(false);
    expect(connectionFailed("no")).toBe(false);
  });
});
