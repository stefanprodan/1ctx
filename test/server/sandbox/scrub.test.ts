// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A key echoed into the sandbox never leaves it: the pulled files and
// open's copies are scrubbed before they commit or show, and a refused
// credential is named in the command's result.

import { describe, expect, test } from "bun:test";
import type { CommandCredential } from "../../../src/server/bash/index.ts";
import { answerOf, setup } from "./backend-helpers.ts";

const KEY = "made-up-key-0123456789abcdef";
const LABEL = "[credential quotes]";
const credential: CommandCredential = {
  name: "quotes",
  prefix: "https://api.example.test/v1/",
  key: KEY,
  header: "Authorization",
  template: "Bearer {key}",
  value: `Bearer ${KEY}`,
  methods: ["GET"],
};
const net = { mode: "hosts" as const, hosts: ["api.example.test"] };

describe("the sandbox's scrub", () => {
  test("a key in a pulled file or an opened copy is replaced", async () => {
    const t = setup();
    const ran = await t.run(
      {
        knowledge: { "a.md": "a\n" },
        net,
        credentials: [credential],
      },
      ({ fs, open }) => {
        fs.write("/knowledge/a.md", `got ${KEY}\n`);
        fs.write("/tmp/echo.json", `{"auth":"Bearer ${KEY}"}`);
        fs.write(
          "/tmp/escaped.json",
          `{"auth":"${KEY.replaceAll("-", "\\u002d")}"}`,
        );
        return {
          stdout: "done",
          opened: open
            ? [{ path: "/knowledge/a.md", text: `got ${KEY}\n` }]
            : [],
        };
      },
    );
    const answer = answerOf(ran.settled);
    const text = (path: string) =>
      new TextDecoder().decode(
        answer.changes!.written.find((file) => file.path === path)!.data,
      );
    expect(answer.changes!.knowledge).toEqual([
      { name: "a.md", text: `got ${LABEL}\n` },
    ]);
    expect(text("echo.json")).toBe(`{"auth":"Bearer ${LABEL}"}`);
    expect(text("escaped.json")).toBe(`{"auth":"${LABEL}"}`);
    expect(answer.opened.map((one) => one.text)).toEqual([`got ${LABEL}\n`]);
  });

  test("a send without a key leaves the files as they are", async () => {
    const t = setup();
    const ran = await t.run(
      {
        net,
        credentials: [
          { name: "quotes", prefix: credential.prefix, refused: "missing" },
        ],
      },
      ({ fs }) => {
        fs.write("/tmp/plain.txt", KEY);
        return {};
      },
    );
    const answer = answerOf(ran.settled);
    expect(new TextDecoder().decode(answer.changes!.written[0]!.data)).toBe(
      KEY,
    );
    expect(answer.notice).toBe(
      "credential quotes has no key, so it is not attached\n",
    );
  });
});
