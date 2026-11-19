// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A key echoed into the sandbox never leaves it: the pulled files and
// open's copies are scrubbed before they commit or show, and a refused
// credential is named in the command's result.

import { describe, expect, test } from "bun:test";
import {
  type CommandCredential,
  escapedForms,
  scrubKeys,
} from "../../../src/server/bash/index.ts";
import { output } from "../../../src/server/bash/output.ts";
import { Capped } from "../../../src/server/sandbox/execs.ts";
import { keptText, outputBytes } from "../../../src/server/sandbox/scrub.ts";
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

  test("the output keeps the longest key form past the shown bytes", async () => {
    const longest = Math.max(
      ...escapedForms(KEY).map((form) => Buffer.byteLength(form)),
    );
    expect(outputBytes(1, [])).toBe(4);
    expect(outputBytes(1, [credential])).toBe(4 + longest);
    const t = setup();
    const ran = await t.run(
      { resultCut: 1, net, credentials: [credential] },
      { stdout: `abc${KEY}${"z".repeat(longest)}` },
    );
    // the key the cut crossed is whole, so the scrub replaces it
    expect(answerOf(ran.settled).stdout.startsWith(`abc${LABEL}`)).toBe(true);
    ran.settle({ landed: false, why: "skipped" });
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
  test("a stream cut inside a key shows no part of it, though the scrub shortens what it kept", async () => {
    const long = `K${"x".repeat(198)}Z`;
    const echo = { ...credential, key: long, value: `Bearer ${long}` };
    const cut = 1000;
    const stream = new Capped(outputBytes(cut, [echo]));
    stream.push(new TextEncoder().encode(`y${long}\n`.repeat(500)));
    expect(stream.dropped).toBeGreaterThan(0);
    const shown = (text: string) =>
      output(scrubKeys(text, [echo]), "", 0, [], cut).content;
    // the bytes as kept end inside a key, which the scrub cannot match
    expect(shown(stream.text())).toMatch(/Kx{5,}/);
    expect(shown(keptText(stream.text(), true, [echo]))).not.toMatch(/Kx/);
    // an uncut stream keeps all it printed
    expect(keptText("ends K", false, [echo])).toBe("ends K");
    // through the backend, a capped stream's tail is cut the same way
    const t = setup();
    const ran = await t.run(
      { net, credentials: [echo], resultCut: cut },
      { stdout: `y${long}\n`.repeat(500) },
    );
    expect(shown(answerOf(ran.settled).stdout)).not.toMatch(/Kx/);
    ran.settle({ landed: false, why: "skipped" });
  });

  test("a cut stream ending in a whole key is scrubbed before its tail is trimmed", () => {
    // its last character also starts it, so a trim first would cut the
    // key by one and leave the rest for no scrub to match
    const key = `s${"x".repeat(30)}s`;
    const echo = { ...credential, key, value: `Bearer ${key}` };
    expect(keptText(`got ${key}`, true, [echo])).toBe(`got ${LABEL}`);
    expect(keptText(`got ${key.slice(0, 9)}`, true, [echo])).toBe("got ");
  });

  test("an opened visual whose title decodes to a key saves nothing and recycles", async () => {
    const t = setup();
    const ran = await t.run(
      { visuals: true, net, credentials: [credential] },
      ({ fs }) => {
        const page = `<title>&#109;${KEY.slice(1)}</title><p>x</p>`;
        fs.write("/knowledge/page.html", page);
        return { opened: [{ path: "/knowledge/page.html", text: page }] };
      },
    );
    expect(answerOf(ran.settled)).toMatchObject({
      changes: null,
      refused: "a file name held a credential, so nothing was saved",
    });
    ran.settle({ landed: false, why: "skipped" });
    expect(await t.settled(ran.hold)).not.toBe("idle");
  });
});
