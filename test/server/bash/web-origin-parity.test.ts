// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { Bash } from "just-bash";
import { originAllowed, urlPrefixes } from "../../../src/shared/web.ts";

test.serial(
  "webfetch's origin rule agrees with the sandbox allow-list",
  async () => {
    const domains = [
      "docs.example.com",
      "xn--bcher-kva.example",
      "10.0.0.7",
      "[::1]",
    ];
    const cases: [string, boolean][] = [
      ["https://docs.example.com/a?b=c", true],
      ["http://docs.example.com/", true],
      ["https://DOCS.example.com/", true],
      ["https://bücher.example/", true],
      ["http://10.0.0.7/x", true],
      ["http://[::1]/x", true],
      ["http://[::1]:80/x", true],
      ["http://[::1]:8080/x", false],
      ["https://docs.example.com:443/", true],
      ["https://docs.example.com:8443/", false],
      ["https://docs.example.com./", false],
      ["https://example.com/", false],
      ["https://a.docs.example.com/", false],
      ["https://docs.example.com.evil.test/", false],
      ["ftp://docs.example.com/", false],
      ["file:///etc/hosts", false],
    ];
    const original = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = Object.assign(
      async () => {
        fetched++;
        return new Response("allowed");
      },
      { preconnect: original.preconnect },
    );
    try {
      const bash = new Bash({
        network: {
          allowedUrlPrefixes: urlPrefixes(domains),
          denyPrivateRanges: false,
        },
      });
      for (const [url, allowed] of cases) {
        const before = fetched;
        const result = await bash.exec(`curl -sS '${url}'`);
        expect(originAllowed(new URL(url), domains), url).toBe(allowed);
        expect(result.exitCode === 0, `${url}: ${result.stderr}`).toBe(allowed);
        expect(fetched - before, url).toBe(allowed ? 1 : 0);
      }
    } finally {
      globalThis.fetch = original;
    }
  },
);
