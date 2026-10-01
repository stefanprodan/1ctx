// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { follow } from "../../../src/server/repos/redirect.ts";
import { fakeHost, redirect } from "../../helpers/repos.ts";

const API = "https://api.git.test/repos/acme/widgets/tarball/abc";
const CODELOAD = "https://codeload.git.test/acme/widgets/legacy.tar.gz/abc";
const header = {
  name: "authorization",
  value: "Bearer secret-value",
  prefix: "https://api.git.test/repos/acme/",
};
const signal = () => new AbortController().signal;

test("the header goes under its prefix and is dropped at the first hop off it", async () => {
  const host = fakeHost({
    [API]: redirect(`${CODELOAD}?token=short`),
    [`${CODELOAD}?token=short`]: redirect(
      "https://api.git.test/repos/acme/widgets/back",
    ),
    "https://api.git.test/repos/acme/widgets/back": new Response("ok"),
  });
  const followed = await follow(
    host.fetch,
    API,
    { accept: "x" },
    header,
    signal(),
  );
  expect(followed.ok).toBe(true);
  expect(host.calls.map((call) => call.headers.authorization ?? null)).toEqual([
    "Bearer secret-value",
    null,
    // back under the prefix, still unsigned
    null,
  ]);
  expect(host.calls.every((call) => call.headers.accept === "x")).toBe(true);
});

test("a URL off the prefix is never signed", async () => {
  const host = fakeHost({ [CODELOAD]: new Response("ok") });
  await follow(host.fetch, CODELOAD, {}, header, signal());
  expect(host.calls[0]!.headers.authorization).toBeUndefined();
});

test("http, userinfo, a fourth hop and a missing location are refused", async () => {
  const refused = async (answers: Record<string, Response>, start = API) => {
    const host = fakeHost(answers);
    const followed = await follow(host.fetch, start, {}, header, signal());
    expect(followed).toMatchObject({ ok: false, error: "host unreachable" });
    return host.calls.length;
  };
  expect(await refused({}, "http://api.git.test/x")).toBe(0);
  expect(await refused({ [API]: redirect("http://codeload.git.test/x") })).toBe(
    1,
  );
  expect(
    await refused({ [API]: redirect("https://user:pw@codeload.git.test/x") }),
  ).toBe(1);
  expect(await refused({ [API]: new Response(null, { status: 302 }) })).toBe(1);
  const hops = {
    [API]: redirect("https://a.git.test/1"),
    "https://a.git.test/1": redirect("https://a.git.test/2"),
    "https://a.git.test/2": redirect("https://a.git.test/3"),
    "https://a.git.test/3": redirect("https://a.git.test/4"),
    "https://a.git.test/4": new Response("ok"),
  };
  expect(await refused(hops)).toBe(4);
  const three = fakeHost({
    ...hops,
    "https://a.git.test/3": new Response("ok"),
  });
  expect((await follow(three.fetch, API, {}, null, signal())).ok).toBe(true);
});

test("a relative location resolves against the hop", async () => {
  const host = fakeHost({
    [API]: redirect("/repos/acme/widgets/other", 307),
    "https://api.git.test/repos/acme/widgets/other": new Response("ok"),
  });
  const followed = await follow(host.fetch, API, {}, header, signal());
  expect(followed.ok).toBe(true);
  expect(host.calls[1]!.headers.authorization).toBe("Bearer secret-value");
});
