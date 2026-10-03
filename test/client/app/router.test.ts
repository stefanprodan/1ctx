// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A same-origin link opens in place unless it asks for a new tab or is
// a download; in an installed app, which has no tabs, a page of the app
// opens in place even when it asks for one.

import { describe, expect, test } from "bun:test";
import { inApp } from "../../../src/client/app/router.ts";

const HERE = "https://1ctx.example.test";
const link = (href: string, blank = false, download = false) => {
  const url = new URL(href, HERE);
  return { origin: url.origin, pathname: url.pathname, download, blank };
};

describe("inApp", () => {
  test("a page of this app opens in place, by path or by full URL", () => {
    for (const standalone of [false, true]) {
      expect(inApp(link("/sessions/abc"), HERE, standalone)).toBe(true);
      expect(
        inApp(link(`${HERE}/projects/p1?tab=files`), HERE, standalone),
      ).toBe(true);
    }
  });

  test("a new-tab link to a page keeps its tab in a browser", () => {
    expect(inApp(link(`${HERE}/projects`, true), HERE, false)).toBe(false);
  });

  test("an installed app opens a new-tab link to a page in place", () => {
    expect(inApp(link(`${HERE}/projects`, true), HERE, true)).toBe(true);
    expect(inApp(link("/apis", true), HERE, true)).toBe(true);
  });

  test("another origin leaves, a port or scheme included", () => {
    for (const standalone of [false, true]) {
      for (const href of [
        "https://example.test/docs",
        "http://1ctx.example.test/",
        "https://1ctx.example.test:8443/",
      ]) {
        expect(inApp(link(href, true), HERE, standalone)).toBe(false);
      }
    }
  });

  test("mailto, a download and a new-tab API link leave", () => {
    const mail = {
      origin: "null",
      pathname: "a@b.test",
      download: false,
      blank: false,
    };
    for (const standalone of [false, true]) {
      expect(inApp(mail, HERE, standalone)).toBe(false);
      expect(
        inApp(link("/sessions/abc/export", false, true), HERE, standalone),
      ).toBe(false);
      expect(inApp(link("/api/health", true), HERE, standalone)).toBe(false);
      expect(inApp(link("/api", true), HERE, standalone)).toBe(false);
    }
  });
});
