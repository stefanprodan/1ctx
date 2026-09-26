// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { keyOptions, NO_KEY } from "../../../src/client/lib/secrets.ts";

test("No key picked is never listed again as a missing file", () => {
  expect(keyOptions(["mcp-github"], NO_KEY)).toEqual([
    { value: "", label: "No key" },
    { value: "mcp-github", label: "mcp-github" },
  ]);
});
