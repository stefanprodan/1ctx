// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandbox's network setting and a send's credentials as the
// sandbox's network: the policy each mode makes, the providers attached and bound in order,
// what recycles a sandbox, and the provider lifecycle, over the fake
// gateway.

import { describe, expect, test } from "bun:test";
import type {
  CommandCredential,
  ShellCall,
} from "../../../src/server/bash/index.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  GLOBAL_POLICY_REFUSAL,
  INSTANCE_LABEL,
  Leases,
  READY_MS,
  type SandboxHold,
} from "../../../src/server/sandbox/index.ts";
import {
  ENCODED_SLASH_HOSTS,
  hashedName,
  planNetwork,
} from "../../../src/server/sandbox/netpolicy.ts";
import {
  envName,
  placeholderValue,
  placement,
  prefixGlob,
} from "../../../src/server/sandbox/rules.ts";
import type { SandboxNet } from "../../../src/shared/sandbox-net.ts";
import { rejection, settle } from "../../helpers/async.ts";
import {
  bindings,
  fakeClock,
  fakeGateway,
  until,
} from "../../helpers/sandbox.ts";

const INSTANCE = "a1b2c3d4e5f6";
const KEY = "made-up-key-0123456789abcdef";
const SEVEN = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];

const signed = (
  fields: Partial<Extract<CommandCredential, { key: string }>> = {},
): CommandCredential => {
  const key = fields.key ?? KEY;
  return {
    name: "quotes",
    prefix: "https://api.example.test/v1/",
    key,
    header: "Authorization",
    template: "Bearer {key}",
    value: `Bearer ${key}`,
    methods: ["GET", "HEAD"],
    ...fields,
  };
};
const LISTED: SandboxNet = {
  mode: "hosts",
  hosts: ["api.example.test", "docs.example.test"],
};
const OFF: SandboxNet = { mode: "off", hosts: ["api.example.test"] };
const plan = (net: SandboxNet, credentials: CommandCredential[] = []) =>
  planNetwork({ credentials }, net, INSTANCE);

type Rule = {
  endpoints: Record<string, unknown>[];
  binaries: { path: string }[];
};

describe("the network policy", () => {
  test("off makes no endpoint and attaches no credential", () => {
    expect(plan(OFF, [signed()])).toEqual({
      mode: "off",
      network: {},
      key: "{}",
      attach: [],
      notice: "",
    });
  });

  test("hosts opens each host on 443 and 80, inspected and enforced, for the wrapper's bash", () => {
    const web = plan(LISTED).network.web as Rule;
    expect(web.binaries).toEqual([{ path: "/usr/bin/bash" }]);
    expect(web.endpoints).toEqual(
      ["api.example.test", "docs.example.test"].flatMap((host) =>
        [443, 80].map((port) => ({
          host,
          port,
          protocol: "rest",
          enforcement: 1,
          rules: SEVEN.map((method) => ({ allow: { method, path: "**" } })),
        })),
      ),
    );
  });

  test("a wildcard host goes to OpenShell as it is", () => {
    const made = plan({
      mode: "hosts",
      hosts: ["**.example.test", "*.githubusercontent.com", "pypi.org"],
    });
    expect(
      (made.network.web as Rule).endpoints.map((endpoint) => [
        endpoint.host,
        endpoint.port,
      ]),
    ).toEqual([
      ["**.example.test", 443],
      ["**.example.test", 80],
      ["*.githubusercontent.com", 443],
      ["*.githubusercontent.com", 80],
      ["pypi.org", 443],
      ["pypi.org", 80],
    ]);
  });

  test("an encoded slash passes on the npm registry alone, unless a credential binds it", () => {
    expect(ENCODED_SLASH_HOSTS).toEqual(["registry.npmjs.org"]);
    const net: SandboxNet = {
      mode: "hosts",
      hosts: ["registry.npmjs.org", "pypi.org"],
    };
    const slash = (made: ReturnType<typeof plan>) =>
      (made.network.web as Rule).endpoints.map((endpoint) => [
        endpoint.host,
        endpoint.port,
        endpoint.allowEncodedSlash ?? false,
      ]);
    expect(slash(plan(net))).toEqual([
      ["registry.npmjs.org", 443, true],
      ["registry.npmjs.org", 80, true],
      ["pypi.org", 443, false],
      ["pypi.org", 80, false],
    ]);
    const bound = plan(net, [
      signed({ prefix: "https://registry.npmjs.org/-/npm/" }),
    ]);
    expect(bound.attach).toHaveLength(1);
    expect(slash(bound).every(([, , open]) => open === false)).toBe(true);
    expect(
      (bound.network.cred_quotes as Rule).endpoints[0]!.allowEncodedSlash,
    ).toBeUndefined();
    // a refused credential binds nothing, so the registry stays open
    const refused = plan(net, [
      {
        ...signed({ prefix: "https://registry.npmjs.org/-/npm/" }),
        header: "Cookie",
        template: "s={key}",
      },
    ]);
    expect(refused.attach).toHaveLength(0);
    expect(slash(refused)[0]).toEqual(["registry.npmjs.org", 443, true]);
  });

  test("a credential binds its prefix and denies every method it lacks", () => {
    const made = plan(LISTED, [signed()]);
    const [one] = made.attach;
    expect(one).toMatchObject({
      name: "quotes",
      key: KEY,
      profile: {
        env: "ONECTX_CRED_QUOTES",
        style: "bearer",
        header: "authorization",
      },
    });
    expect(made.network.cred_quotes).toEqual({
      name: "cred_quotes",
      endpoints: [
        {
          host: "api.example.test",
          port: 443,
          path: "/v1/**",
          protocol: "rest",
          enforcement: 1,
          rules: ["/v1", "/v1/**"].flatMap((path) => [
            { allow: { method: "GET", path } },
            { allow: { method: "HEAD", path } },
          ]),
          denyRules: ["/v1", "/v1/**"].flatMap((path) =>
            ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"].map((method) => ({
              method,
              path,
            })),
          ),
          credentialBinding: { provider: one!.provider },
        },
      ],
      binaries: [{ path: "/usr/bin/bash" }],
    });
    expect(made.notice).toBe("");
  });

  test("a credential's host joins the policy though the snapshot does not list it", () => {
    const made = plan({ mode: "hosts", hosts: ["other.test"] }, [
      signed({ prefix: "https://unlisted.test:8443/api" }),
    ]);
    const [endpoint] = (made.network.cred_quotes as Rule).endpoints;
    expect(endpoint).toMatchObject({
      host: "unlisted.test",
      port: 8443,
      path: "/api/**",
    });
    // the bare prefix is the credential's alone, its methods included
    expect(
      (endpoint!.rules as { allow: { path: string } }[]).map(
        (rule) => rule.allow.path,
      ),
    ).toEqual(["/api", "/api", "/api/**", "/api/**"]);
  });

  test("a root prefix names the root path and every path under it", () => {
    const [endpoint] = (
      plan(LISTED, [signed({ prefix: "https://api.example.test/" })]).network
        .cred_quotes as Rule
    ).endpoints;
    expect(endpoint!.path).toBe("/**");
    expect(
      (endpoint!.denyRules as { path: string }[]).map((rule) => rule.path),
    ).toEqual([...Array(5).fill("/"), ...Array(5).fill("/**")]);
  });

  test("names are hashes of the instance and the credential", () => {
    const a = plan(LISTED, [signed()]).attach[0]!;
    const b = planNetwork({ credentials: [signed()] }, LISTED, "other")
      .attach[0]!;
    expect(a.provider).toMatch(/^1ctx-[0-9a-z]{14}$/);
    expect(a.profile.id).toMatch(/^1ctx-[0-9a-z]{14}$/);
    expect(a.provider).not.toBe(b.provider);
    expect(hashedName("x")).toBe(hashedName("x"));
    expect(plan(LISTED, [signed()]).attach[0]!.provider).toBe(a.provider);
  });

  test("a rotated key or a moved prefix is another provider of the same profile", () => {
    const a = plan(LISTED, [signed()]).attach[0]!;
    for (const fields of [
      { key: `${KEY}-rotated`, value: `Bearer ${KEY}-rotated` },
      { prefix: "https://api.example.test/v2/" },
    ]) {
      const b = plan(LISTED, [signed(fields)]).attach[0]!;
      expect(b.provider).not.toBe(a.provider);
      expect(b.profile.id).toBe(a.profile.id);
    }
  });

  test("a prefix whose host is a pattern or an IPv6 literal is left out", () => {
    const made = plan(LISTED, [
      signed({ name: "a-star", prefix: "https://*/v1/" }),
      signed({ name: "b-sub", prefix: "https://*.example.test/v1/" }),
      signed({ name: "c-v6", prefix: "https://[::1]/v1/" }),
      signed(),
    ]);
    expect(made.attach.map((one) => one.name)).toEqual(["quotes"]);
    expect(made.notice).toBe(
      ["a-star", "b-sub", "c-v6"]
        .map(
          (name) =>
            `credential ${name} has a prefix the sandbox cannot match, so it is not attached\n`,
        )
        .join(""),
    );
    expect(Object.keys(made.network).sort()).toEqual(["cred_quotes", "web"]);
  });

  test("refused credentials are left out and each is named", () => {
    const made = plan(LISTED, [
      signed(),
      { name: "a-off", prefix: "https://a.test/", refused: "off" },
      { name: "b-writes", prefix: "https://b.test/", refused: "writes" },
      { name: "c-missing", prefix: "https://c.test/", refused: "missing" },
      signed({ name: "d-cookie", header: "Cookie", template: "s={key}" }),
      signed({
        name: "e-wrapped",
        header: "X-Api-Key",
        template: "Token {key}",
      }),
      signed({ name: "f-glob", prefix: "https://f.test/v*/" }),
      signed({ name: "quo-tes", prefix: "https://g.test/" }),
      signed({ name: "quo_tes", prefix: "https://h.test/" }),
      signed({ name: "x-key", header: "X-Api-Key", template: "{key}" }),
    ]);
    expect(made.attach.map((one) => one.name)).toEqual([
      "quo-tes",
      "quotes",
      "x-key",
    ]);
    expect(made.notice).toBe(
      [
        "credential a-off is off in this chat, so it is not attached",
        "credential b-writes signs only writes, which a subagent cannot send, so it is not attached",
        "credential c-missing has no key, so it is not attached",
        "credential d-cookie goes in a Cookie header the sandbox cannot fill, so it is not attached",
        "credential e-wrapped goes in a X-Api-Key header the sandbox cannot fill, so it is not attached",
        "credential f-glob has a prefix the sandbox cannot match, so it is not attached",
        "credential quo_tes shares the variable ONECTX_CRED_QUO_TES with credential quo-tes, so it is not attached",
        "",
      ].join("\n"),
    );
    expect(Object.keys(made.network).sort()).toEqual([
      "cred_quo_tes",
      "cred_quotes",
      "cred_x_key",
      "web",
    ]);
  });
});

describe("the sandbox's credential rules", () => {
  test("a prefix becomes OpenShell's glob", () => {
    expect(prefixGlob("https://a.test/v1/")).toEqual({
      host: "a.test",
      port: 443,
      path: "/v1/**",
      base: "/v1",
    });
    expect(prefixGlob("https://a.test/v1")).toMatchObject({
      path: "/v1/**",
      base: "/v1",
    });
    expect(prefixGlob("https://a.test/")).toMatchObject({
      path: "/**",
      base: "/",
    });
    expect(prefixGlob("https://a.test:9443/x/y.json")).toEqual({
      host: "a.test",
      port: 9443,
      path: "/x/y.json/**",
      base: "/x/y.json",
    });
    expect(prefixGlob("https://a.test/v{1}/")).toBeNull();
    expect(prefixGlob("https://a.test/a%2Fb/")).toBeNull();
    expect(prefixGlob("https://*.a.test/")).toBeNull();
    expect(prefixGlob("https://[::1]:8443/")).toBeNull();
    expect(prefixGlob("https://10.0.0.1/v1/")?.host).toBe("10.0.0.1");
  });

  test("a placement OpenShell can fill, or none", () => {
    expect(placement("Authorization", "token {key}")).toEqual({
      style: "bearer",
      header: "authorization",
    });
    expect(placement("X-Api-Key", "{key}")).toEqual({
      style: "header",
      header: "x-api-key",
    });
    expect(placement("X-Api-Key", "Token {key}")).toBeNull();
    expect(placement("Cookie", "{key}")).toBeNull();
    expect(envName("my-api_2")).toBe("ONECTX_CRED_MY_API_2");
    expect(placeholderValue("Bearer {key}", "gh")).toBe(
      "Bearer $ONECTX_CRED_GH",
    );
  });
});

function setup() {
  const time = fakeClock();
  const fake = fakeGateway();
  const leases = new Leases({
    clock: time.clock,
    log: silent,
    gateway: fake.connect({
      endpoint: "https://gateway.test:17670",
      ca: "ca",
      cert: "cert",
      key: "key",
    }),
    instanceId: INSTANCE,
    image: "img",
    limits: () => DEFAULT_LIMITS,
    repos: { hold: () => () => {} },
    net: () => net,
  });
  let net: SandboxNet = OFF;
  const call = (
    given: SandboxNet,
    credentials: CommandCredential[] = [],
    workspace = "chat",
    sendId = "send",
  ): ShellCall => {
    net = given;
    return {
      projectId: "project",
      workspace: { id: workspace, sessionId: workspace },
      sendId,
      subagent: false,
      repos: [],
      repoFileBytes: 0,
      network: true,
      credentials,
    };
  };
  const acquire = (
    given: SandboxNet,
    credentials: CommandCredential[] = [],
    workspace = "chat",
    sendId = "send",
  ) =>
    leases.acquire(
      call(given, credentials, workspace, sendId),
      time.now() + 20_000,
      new AbortController().signal,
    ) as Promise<SandboxHold>;
  const state = (sandbox: string) =>
    leases.rows().find((row) => row.sandbox === sandbox)?.state;
  return { time, fake, leases, call, acquire, state };
}

describe("a sandbox's network", () => {
  test("attach, then bind, then readiness; withheld before the bind is no error", async () => {
    const t = setup();
    const hold = await t.acquire(LISTED, [signed()]);
    const [one] = plan(LISTED, [signed()]).attach;
    expect(t.fake.calls).toEqual([
      `attach:${one!.provider}`,
      `policy:${hold.sandbox}`,
      `state:${one!.provider}`,
    ]);
    expect(t.fake.puts).toEqual([
      {
        name: one!.provider,
        profile: one!.profile.id,
        env: "ONECTX_CRED_QUOTES",
        key: KEY,
        labels: { [INSTANCE_LABEL]: INSTANCE },
      },
    ]);
    expect(t.fake.profiles.get(one!.profile.id)).toEqual({
      id: one!.profile.id,
      env: "ONECTX_CRED_QUOTES",
      style: "bearer",
      header: "authorization",
      annotations: { [INSTANCE_LABEL]: INSTANCE },
    });
    expect(bindings(t.fake.policies[0]!.network)).toEqual([one!.provider]);
    expect(hold.notice).toBe("");
  });

  test("off on a fresh sandbox loads nothing, and an unchanged policy is never loaded again", async () => {
    const t = setup();
    const off = await t.acquire(OFF);
    off.release();
    expect(t.fake.policies).toEqual([]);
    const first = await t.acquire(LISTED, [signed()]);
    first.release();
    const again = await t.acquire(LISTED, [signed()]);
    again.release();
    expect(again.sandbox).toBe(off.sandbox);
    expect(t.fake.policies).toHaveLength(1);
    expect(t.fake.calls.filter((c) => c.startsWith("attach"))).toHaveLength(1);
    expect(t.fake.puts).toHaveLength(1);
  });

  test("a credential added on a warm sandbox is attached, then bound, in place", async () => {
    const t = setup();
    const first = await t.acquire(LISTED);
    first.release();
    t.fake.calls.length = 0;
    const second = await t.acquire(LISTED, [signed()]);
    expect(second.sandbox).toBe(first.sandbox);
    expect(t.fake.calls.map((c) => c.split(":")[0])).toEqual([
      "attach",
      "policy",
      "state",
    ]);
  });

  test("a rotated key, a removed credential or the network turned off recycles the sandbox", async () => {
    for (const next of [
      { net: LISTED, credentials: [signed({ key: `${KEY}-rotated` })] },
      { net: LISTED, credentials: [] },
      { net: OFF, credentials: [signed()] },
      { net: OFF, credentials: [] },
      {
        net: LISTED,
        credentials: [signed({ prefix: "https://api.example.test/v2/" })],
      },
    ]) {
      const t = setup();
      const first = await t.acquire(LISTED, [signed()]);
      first.release();
      const second = await t.acquire(next.net, next.credentials);
      expect(second.sandbox).not.toBe(first.sandbox);
      await until(() => t.state(first.sandbox) === undefined);
      expect(t.fake.deletes).toEqual([first.sandbox]);
    }
  });

  test("the network turned off recycles a sandbox with no credential, and turned on keeps it", async () => {
    const t = setup();
    const first = await t.acquire(LISTED);
    first.release();
    const off = await t.acquire(OFF);
    expect(off.sandbox).not.toBe(first.sandbox);
    off.release();
    const on = await t.acquire(LISTED);
    expect(on.sandbox).toBe(off.sandbox);
    on.release();
    expect(t.fake.policies).toHaveLength(2);
  });

  test("a send without web access runs with the network off, whatever the setting", async () => {
    const t = setup();
    const first = await t.acquire(LISTED, [signed()]);
    first.release();
    const off = await t.leases.acquire(
      { ...t.call(LISTED, [signed()]), network: false },
      t.time.now() + 20_000,
      new AbortController().signal,
    );
    if (off === "busy") throw new Error("busy");
    expect(off.sandbox).not.toBe(first.sandbox);
    expect(t.fake.policies).toHaveLength(1);
    expect(t.fake.attached.get(off.sandbox)).toBeUndefined();
  });

  test("off attaches no credential", async () => {
    const t = setup();
    const hold = await t.acquire(OFF, [signed()]);
    expect(t.fake.puts).toEqual([]);
    expect(t.fake.attached.get(hold.sandbox)).toBeUndefined();
    expect(t.fake.policies).toEqual([]);
  });

  test("the notice is named by each send's first command alone", async () => {
    const t = setup();
    const cookie = signed({ name: "c", header: "Cookie", template: "{key}" });
    const first = await t.acquire(LISTED, [cookie]);
    expect(first.notice).toContain("credential c goes in a Cookie header");
    first.release();
    const second = await t.acquire(LISTED, [cookie]);
    expect(second.notice).toBe("");
    second.release();
    const next = await t.acquire(LISTED, [cookie], "chat", "send-2");
    expect(next.notice).toContain("credential c");
  });

  test("a global policy set since start refuses the command and keeps the sandbox", async () => {
    const t = setup();
    const first = await t.acquire(LISTED);
    first.release();
    t.fake.globalPolicy = true;
    const error = await rejection(t.acquire(LISTED));
    expect(error.message).toBe(GLOBAL_POLICY_REFUSAL);
    expect(t.state(first.sandbox)).toBe("idle");
    expect(t.fake.policies).toHaveLength(1);
    // the admin is told, until the next ask finds it gone
    expect(t.leases.refused()).toBe(GLOBAL_POLICY_REFUSAL);
    t.fake.globalPolicy = false;
    const again = await t.acquire(LISTED);
    expect(again.sandbox).toBe(first.sandbox);
    expect(t.leases.refused()).toBeNull();
  });

  test("a provider the sandbox could not apply fails the command and recycles", async () => {
    const t = setup();
    t.fake.providerState = () => "failed";
    const error = await rejection(t.acquire(LISTED, [signed()]));
    expect(error.message).toBe("the sandbox network could not be set up");
    await until(() => t.fake.deletes.length === 1);
  });

  test("readiness waits past pending, and a provider never ready fails at its bound", async () => {
    const t = setup();
    let asked = 0;
    t.fake.providerState = () => (++asked < 3 ? "pending" : "ready");
    const ready = t.acquire(LISTED, [signed()]);
    // a poll's pause, past the step's own deadline timers
    const polling = (time: typeof t.time) => () =>
      time.sleeping().includes(time.now() + 50);
    for (let i = 0; i < 2; i++) {
      await until(polling(t.time));
      t.time.advance(50);
    }
    expect((await ready).sandbox).toMatch(/^1ctx-/);
    expect(asked).toBe(3);

    const u = setup();
    u.fake.providerState = () => "withheld";
    const never = rejection(u.acquire(LISTED, [signed()]));
    await until(polling(u.time));
    u.time.advance(READY_MS);
    expect((await never).message).toBe(
      "the sandbox network could not be set up",
    );
  });

  test("a provider goes once no sandbox uses it, then its profile", async () => {
    const t = setup();
    const a = await t.acquire(LISTED, [signed()], "a");
    const b = await t.acquire(LISTED, [signed()], "b");
    const [one] = plan(LISTED, [signed()]).attach;
    expect(t.fake.puts).toHaveLength(1);
    a.release();
    b.release();
    t.leases.recycle("a", "clear");
    await until(() => t.state(a.sandbox) === undefined);
    expect(t.fake.providerDeletes).toEqual([]);
    t.leases.recycle("b", "clear");
    await until(() => t.fake.profileDeletes.length === 1);
    expect(t.fake.providerDeletes).toEqual([one!.provider]);
    expect(t.fake.profileDeletes).toEqual([one!.profile.id]);
  });

  test("a provider's drop keeps the profile a rotated key's provider is being put on", async () => {
    const t = setup();
    t.fake.deleteMode = "pending";
    const rotated = `${KEY}-rotated`;
    const newer = signed({ key: rotated, value: `Bearer ${rotated}` });
    const first = await t.acquire(LISTED, [signed()]);
    first.release();
    const [old] = plan(LISTED, [signed()]).attach;
    const resume = t.fake.pause("put");
    // the rotation recycles the sandbox, and the new one's put waits
    const second = t.acquire(LISTED, [newer]);
    await until(
      () => t.fake.deletes.includes(first.sandbox) && t.fake.paused === 1,
    );
    t.fake.finish(first.sandbox);
    await until(() => t.fake.providerDeletes.length === 1);
    await settle();
    expect(t.fake.providerDeletes).toEqual([old!.provider]);
    expect(t.fake.profileDeletes).toEqual([]);
    resume();
    const hold = await second;
    expect(hold.sandbox).not.toBe(first.sandbox);
    expect(t.fake.profiles.has(old!.profile.id)).toBe(true);
  });

  test("the start sweep deletes this instance's profiles, never another's", async () => {
    const t = setup();
    const mine = { [INSTANCE_LABEL]: INSTANCE };
    t.fake.profiles.set("1ctx-mine", {
      id: "1ctx-mine",
      env: "ONECTX_CRED_A",
      style: "bearer",
      header: "authorization",
      annotations: mine,
    });
    t.fake.profiles.set("theirs", {
      id: "theirs",
      env: "X",
      style: "bearer",
      header: "authorization",
      annotations: { [INSTANCE_LABEL]: "other" },
    });
    await t.leases.start();
    expect(t.fake.profileDeletes).toEqual(["1ctx-mine"]);
    t.leases.close();
  });

  test("a key read before a rotation never replaces the newer one another sandbox holds", async () => {
    const t = setup();
    const rotated = `${KEY}-rotated`;
    const newer = signed({ key: rotated, value: `Bearer ${rotated}` });
    // b reads the rotated key first, then a's send, begun before the
    // rotation, attaches with the old one
    const b = await t.acquire(LISTED, [newer], "b");
    const a = await t.acquire(LISTED, [signed()], "a");
    const keyOf = (sandbox: string) => {
      const [provider] = t.fake.attached.get(sandbox)!;
      const puts = t.fake.puts.filter((put) => put.name === provider);
      expect(puts).toHaveLength(1);
      return puts[0]!.key;
    };
    expect(keyOf(b.sandbox)).toBe(rotated);
    expect(keyOf(a.sandbox)).toBe(KEY);
    // b's next command keeps its sandbox and its key
    b.release();
    const again = await t.acquire(LISTED, [newer], "b");
    expect(again.sandbox).toBe(b.sandbox);
    expect(keyOf(b.sandbox)).toBe(rotated);
    expect(t.fake.puts).toHaveLength(2);
  });

  test("a command waiting on another's attach of its provider ends at its own deadline", async () => {
    const t = setup();
    t.fake.hang("attach");
    const start = t.time.now();
    const signal = new AbortController().signal;
    let longEnded = false;
    const long = t.leases
      .acquire(t.call(LISTED, [signed()], "a"), start + 20_000, signal)
      .then(
        (got) => got,
        (error: Error) => error,
      )
      .finally(() => {
        longEnded = true;
      });
    const [one] = plan(LISTED, [signed()]).attach;
    await until(() => t.fake.calls.includes(`attach:${one!.provider}`));
    const short = t.leases.acquire(
      t.call(LISTED, [signed()], "b"),
      start + 5_000,
      signal,
    );
    // b's sandbox is made, so it waits on a's lock once its turns run
    await until(() =>
      t.leases
        .rows()
        .some((row) => row.workspace === "b" && row.state === "leased"),
    );
    await settle();
    t.time.advance(5_000);
    expect(await short).toBe("busy");
    expect(longEnded).toBe(false);
    // b never reached the gateway's attach
    expect(
      t.fake.calls.filter((call) => call === `attach:${one!.provider}`),
    ).toHaveLength(1);
    t.time.advance(15_000);
    expect(await long).toBe("busy");
  });

  test("a restart's sweep keeps the providers a lease still uses", async () => {
    const t = setup();
    await t.leases.start();
    const hold = await t.acquire(LISTED, [signed()]);
    const [one] = plan(LISTED, [signed()]).attach;
    // a held lease outlives the sweep until its command ends
    await t.leases.restarted();
    expect(t.fake.providerDeletes).toEqual([]);
    hold.release();
    await until(() => t.fake.providerDeletes.length === 1);
    expect(t.fake.providerDeletes).toEqual([one!.provider]);
    t.leases.close();
  });
});
