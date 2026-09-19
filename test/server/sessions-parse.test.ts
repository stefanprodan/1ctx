// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { BadRequest } from "../../src/server/lib/errors.ts";
import {
  parseCreateSession,
  parseSendMessage,
} from "../../src/server/sessions/index.ts";
import { MAX_UPLOADS_PER_MESSAGE } from "../../src/shared/uploads.ts";

for (const [name, parse] of [
  ["create", parseCreateSession],
  ["send", parseSendMessage],
] as const) {
  const base =
    name === "create"
      ? { projectId: "project", agentId: "agent", message: "read these" }
      : { message: "read these" };
  describe(`${name} uploads`, () => {
    test("allows absent, empty and up to ten distinct ids", () => {
      expect(parse(base)).not.toHaveProperty("uploads");
      expect(parse({ ...base, uploads: [] }).uploads).toEqual([]);
      const uploads = Array.from(
        { length: MAX_UPLOADS_PER_MESSAGE },
        (_, i) => `upload-${i}`,
      );
      expect(parse({ ...base, uploads }).uploads).toEqual(uploads);
    });

    for (const [label, uploads] of [
      ["null", null],
      ["undefined", undefined],
      ["string", "upload"],
      ["object", { id: "upload" }],
      ["number", 1],
      ["empty id", [""]],
      ["blank id", ["  "]],
      ["non-string id", ["upload", 1]],
      ["null id", [null]],
      ["repeated id", ["upload", "upload"]],
      [
        "too many ids",
        Array.from(
          { length: MAX_UPLOADS_PER_MESSAGE + 1 },
          (_, i) => `upload-${i}`,
        ),
      ],
    ] as const) {
      test(`refuses ${label} naming uploads`, () => {
        expect(() => parse({ ...base, uploads })).toThrow(BadRequest);
        expect(() => parse({ ...base, uploads })).toThrow("uploads");
      });
    }

    test("attachments do not replace the required message text", () => {
      expect(() =>
        parse({ ...base, message: " \n ", uploads: ["upload"] }),
      ).toThrow("message must be text");
    });
  });
}
