// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  locate,
  locationAvailable,
  locationFailure,
  locationLine,
  locationMessage,
  NEEDS_HTTPS,
} from "../../../src/client/composer/location.ts";

const FIX = { latitude: 44.426801234, longitude: 26.1025, accuracy: 29.6 };

describe("the location line", () => {
  test("has five decimals and the accuracy in whole metres", () => {
    expect(locationLine(FIX)).toBe("My location: 44.42680, 26.10250 (±30 m)");
    expect(
      locationLine({ latitude: -33.8688, longitude: -151.2093, accuracy: 4.4 }),
    ).toBe("My location: -33.86880, -151.20930 (±4 m)");
  });

  test("follows the question, or goes alone", () => {
    const line = "My location: 44.42680, 26.10250 (±30 m)";
    expect(locationMessage("  Any cafes near me? \n", FIX)).toBe(
      `Any cafes near me?\n\n${line}`,
    );
    expect(locationMessage("", FIX)).toBe(line);
    expect(locationMessage(" \n ", FIX)).toBe(line);
  });

  test("a failure says why by its code", () => {
    expect(locationFailure(1)).toBe("/location: blocked in the browser");
    expect(locationFailure(2)).toBe("/location: no position found");
    expect(locationFailure(3)).toBe("/location: no position found");
  });
});

describe("reading the position", () => {
  test("needs a secure context with geolocation", () => {
    expect(locationAvailable(true, { geolocation: {} })).toBe(true);
    expect(locationAvailable(false, { geolocation: {} })).toBe(false);
    expect(locationAvailable(undefined, { geolocation: {} })).toBe(false);
    expect(locationAvailable(true, {})).toBe(false);
    expect(locationAvailable(true, undefined)).toBe(false);
  });

  test("builds the message from one read, or refuses", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return FIX;
    };
    expect(await locate("where am I?", read)).toBe(
      "where am I?\n\nMy location: 44.42680, 26.10250 (±30 m)",
    );
    expect(reads).toBe(1);
    await expect(locate("x", null)).rejects.toThrow(NEEDS_HTTPS);
    const blocked = async () => {
      throw new Error(locationFailure(1));
    };
    await expect(locate("x", blocked)).rejects.toThrow(
      "/location: blocked in the browser",
    );
  });
});
