// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { privateHost } from "../../../src/server/lib/hosts.ts";

test("private hosts are told from public ones on the URL's host alone", () => {
  const cases: [string, boolean][] = [
    ["http://127.0.0.1/", true],
    ["http://127.8.9.10/", true],
    ["http://10.0.0.1/", true],
    ["http://172.16.0.1/", true],
    ["http://172.31.255.255/", true],
    ["http://192.168.0.1/", true],
    ["http://169.254.169.254/", true],
    ["http://100.64.0.1/", true],
    ["http://0.0.0.0/", true],
    ["http://224.0.0.1/", true],
    ["http://255.255.255.255/", true],
    ["http://2130706433/", true],
    ["http://0x7f.1/", true],
    ["http://0177.0.0.1/", true],
    ["http://127.1/", true],
    ["http://[::]/", true],
    ["http://[::1]/", true],
    ["http://[0:0:0:0:0:0:0:1]/", true],
    ["http://[::ffff:127.0.0.1]/", true],
    ["http://[::ffff:a9fe:a9fe]/", true],
    ["http://[::127.0.0.1]/", true],
    ["http://[fe80::1]/", true],
    ["http://[fd12:3456::1]/", true],
    ["http://[fc00::1]/", true],
    ["http://[ff02::1]/", true],
    ["http://[64:ff9b::a00:1]/", true],
    ["http://[2002:7f00:1::]/", true],
    ["http://localhost/", true],
    ["http://LocalHost./", true],
    ["http://a.b.localhost/", true],
    ["http://93.184.216.34/", false],
    ["http://172.32.0.1/", false],
    ["http://100.128.0.1/", false],
    ["http://[2606:4700::1111]/", false],
    ["http://[::ffff:8.8.8.8]/", false],
    ["http://[64:ff9b::808:808]/", false],
    ["https://example.com/", false],
    ["https://localhost.example.com/", false],
    ["https://mylocalhost/", false],
    ["https://10.0.0.1.example.com/", false],
  ];
  for (const [url, expected] of cases) {
    expect(privateHost(new URL(url).hostname), url).toBe(expected);
  }
});

test("an address with a dotted IPv4 tail is read too", () => {
  expect(privateHost("[::ffff:10.0.0.1]")).toBe(true);
  expect(privateHost("[::10.0.0.1]")).toBe(true);
  expect(privateHost("[::ffff:8.8.8.8]")).toBe(false);
  expect(privateHost("[1:2:3:4:5:6:7:8:9]")).toBe(false);
});
