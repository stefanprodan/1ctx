// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Sandbox kind: one per instance, always an update of the row the
// database made, its endpoint https, its shell needing the gateway's
// key files before anything is written.

import { describe, expect, test } from "bun:test";
import {
  type Document,
  preflight,
} from "../../../src/server/provision/parse.ts";
import { SANDBOX_DEFAULT_HOSTS } from "../../../src/shared/sandbox-net.ts";
import type { SecretKind } from "../../../src/shared/words.ts";
import { type TestApp, testApp } from "../../helpers/app.ts";
import { documents, object } from "./helpers.ts";

const KEYS = {
  "openshell-gateway-ca": "ca",
  "openshell-gateway-cert": "cert",
  "openshell-gateway-key": "key",
};
const ENDPOINT = "https://gateway.test:17670";
const sandbox = (spec: Record<string, unknown>, name = "sandbox") =>
  object("Sandbox", name, spec);

async function run(
  body: (app: TestApp, apply: typeof applied) => Promise<void>,
) {
  const app = await testApp({ activate: false, secrets: KEYS });
  try {
    await body(app, applied);
  } finally {
    await app.shutdown();
    app.db.close();
  }
  async function applied(...objects: ReturnType<typeof object>[]) {
    const lines: string[] = [];
    await app.provision.apply(documents(...objects), (line) =>
      lines.push(line),
    );
    return lines;
  }
}

const check = (docs: Document[], keys: Record<string, string>) =>
  preflight(
    docs,
    {
      User: [],
      SmtpServer: [],
      Project: [],
      Credential: [],
      Repository: [],
      Provider: [],
      Decider: [],
      Dictation: [],
      Sandbox: ["sandbox"],
      Skill: [],
      McpServer: [],
      Agent: [],
      Tool: [],
    },
    (_kind: SecretKind, name: string) => keys[name] ?? null,
    { mode: "all", domains: [] },
    () => ({ caps: {} as never, live: [], labels: [] }),
    { key: () => "ok", list: () => [] },
  );

describe("provision Sandbox", () => {
  test("a second Sandbox document is refused", () => {
    expect(() =>
      documents(sandbox({ shell: "builtin" }), sandbox({}, "other")),
    ).toThrow(
      "Sandbox/other: one Sandbox object per instance (first Sandbox/sandbox)",
    );
  });

  test("the endpoint must be an https origin", () => {
    expect(() =>
      documents(sandbox({ endpoint: "http://gateway.test:17670" })),
    ).toThrow("spec.endpoint: must be null or an https origin");
  });

  test("the network is off or hosts, each host one OpenShell takes", () => {
    expect(() => documents(sandbox({ network: "all" }))).toThrow(
      "spec.network: must be off or hosts",
    );
    expect(() => documents(sandbox({ hosts: ["pypi.org", "*.com"] }))).toThrow(
      'spec.hosts: "*.com" needs three labels as a wildcard',
    );
    expect(() => documents(sandbox({ hosts: "pypi.org" }))).toThrow(
      "spec.hosts: must be null or a list",
    );
  });

  test("the sandbox shell needs the gateway's key files before apply", () => {
    const docs = documents(sandbox({ shell: "sandbox", endpoint: ENDPOINT }));
    expect(() => check(docs, {})).toThrow(
      "spec.shell secret openshell-gateway-ca.key is missing or empty",
    );
    check(docs, KEYS);
  });

  test("updates the row the database made, then is unchanged", async () => {
    await run(async (app, apply) => {
      const id = app.sandbox.store.settings().instanceId;
      const doc = sandbox({ shell: "sandbox", endpoint: ENDPOINT });
      expect(await apply(doc)).toContain("updated sandbox/sandbox");
      expect(app.sandbox.store.settings()).toMatchObject({
        shell: "sandbox",
        endpoint: ENDPOINT,
        image: null,
        instanceId: id,
      });
      expect(await apply(doc)).toContain("unchanged sandbox/sandbox");
      // left out, the image stays; null takes it back to the default
      await apply(sandbox({ image: "registry.test/sbx:2" }));
      expect(app.sandbox.store.settings().image).toBe("registry.test/sbx:2");
      await apply(sandbox({ image: null }));
      expect(app.sandbox.store.settings()).toMatchObject({
        shell: "sandbox",
        image: null,
      });
      // hosts compare as the sorted list a save stores
      const net = sandbox({
        network: "off",
        hosts: ["pypi.org", "*.githubusercontent.com"],
      });
      expect(await apply(net)).toContain("updated sandbox/sandbox");
      expect(app.sandbox.store.settings()).toMatchObject({
        network: "off",
        hosts: ["*.githubusercontent.com", "pypi.org"],
      });
      expect(await apply(net)).toContain("unchanged sandbox/sandbox");
      await apply(sandbox({ network: "hosts", hosts: null }));
      expect(app.sandbox.store.settings()).toMatchObject({
        network: "hosts",
        hosts: null,
      });
      // the defaults written out are the defaults: stored as null, and
      // unchanged on the next apply
      const listed = sandbox({ hosts: [...SANDBOX_DEFAULT_HOSTS] });
      expect(await apply(listed)).toContain("unchanged sandbox/sandbox");
      await apply(sandbox({ hosts: ["a.test"] }));
      expect(await apply(listed)).toContain("updated sandbox/sandbox");
      expect(app.sandbox.store.settings().hosts).toBeNull();
    });
  });
});
