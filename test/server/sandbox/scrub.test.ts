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
        fs.write("/knowledge/echo.json", `{"auth":"Bearer ${KEY}"}`);
        fs.write(
          "/knowledge/escaped.json",
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
    expect(answer.changes!.knowledge).toEqual([
      { name: "a.md", text: `got ${LABEL}\n` },
      { name: "echo.json", text: `{"auth":"Bearer ${LABEL}"}` },
      { name: "escaped.json", text: `{"auth":"${LABEL}"}` },
    ]);
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
        fs.write("/knowledge/plain.md", KEY);
        return {};
      },
    );
    const answer = answerOf(ran.settled);
    expect(answer.changes!.knowledge).toEqual([
      { name: "plain.md", text: KEY },
    ]);
    expect(answer.notice).toBe(
      "credential quotes has no key, so it is not attached\n",
    );
  });
});
