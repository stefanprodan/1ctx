// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { bytesWords } from "../../../src/server/lib/bytes.ts";

test("words a byte cap in binary units", () => {
  expect(bytesWords(512)).toBe("512 B");
  expect(bytesWords(64 * 1024)).toBe("64 KB");
  expect(bytesWords(1024 * 1024)).toBe("1 MB");
  expect(bytesWords(1.5 * 1024 * 1024)).toBe("1.5 MB");
  expect(bytesWords(32 * 1024 * 1024)).toBe("32 MB");
});
