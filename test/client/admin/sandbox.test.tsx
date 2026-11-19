// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Config board's Sandbox page: its words, the Shell and Network
// cards' drafts and refusals against the route, the sandboxes with stuck ones named,
// and its place in the Config zone.

import { afterEach, describe, expect, test } from "bun:test";
import { type Signal, signal } from "@preact/signals";
import { options } from "preact";
import { act } from "preact/test-utils";
import { render } from "preact-render-to-string";
import { ZONES } from "../../../src/client/app/zones.ts";
import {
  LEASES_EVERY_MS,
  loadSandbox,
  sandbox,
  sandboxError,
  sandboxLeases,
  sandboxLeasesError,
  sandboxRefused,
  watchSandboxLeases,
} from "../../../src/client/data/sandbox.ts";
import { Save } from "../../../src/client/lib/save.ts";
import {
  BACKEND_OPTIONS,
  backendLine,
  draftOf,
  gatewayShown,
  HOSTS_HINT,
  leaseCounts,
  leaseSub,
  NET_DEFAULTS,
  netAtDefaults,
  netBody,
  netCount,
  netDirty,
  netDraftOf,
  netFieldOf,
  offLine,
  overridesLine,
  type SandboxDraft,
  sandboxBody,
  sandboxDirty,
  sandboxFieldOf,
  sandboxOn,
  stuckLine,
} from "../../../src/client/views/admin/Sandbox.model.ts";
import {
  Sandbox,
  SandboxCards,
  SandboxView,
} from "../../../src/client/views/admin/Sandbox.tsx";
import type { SandboxResponse } from "../../../src/shared/api/sandbox.ts";
import type {
  LeaseRow,
  SandboxSettings,
} from "../../../src/shared/contracts/sandbox.ts";
import { SANDBOX_DEFAULT_HOSTS } from "../../../src/shared/sandbox-net.ts";
import { settle } from "../../helpers/async.ts";
import { deferredFetch } from "../../helpers/client-fetch.ts";
import { mount } from "../../helpers/mount.ts";
import { pollTab } from "../../helpers/poll.ts";

const settings: SandboxSettings = {
  backend: "openshell",
  endpoint: "https://127.0.0.1:17671",
  image: null,
  network: "hosts",
  hosts: null,
  instanceId: "abc123",
  updatedAt: 5,
};
const DEFAULTS_TEXT = SANDBOX_DEFAULT_HOSTS.join("\n");

const response = (over: Partial<SandboxResponse> = {}): SandboxResponse => ({
  settings,
  defaultImage: "ghcr.io/stefanprodan/1ctx-shell:dev",
  gatewayLabel: "1ctx-abc123",
  keys: { ca: true, cert: true, key: true },
  active: true,
  overrides: { builtin: 0, openshell: 0 },
  ...over,
});

const lease = (over: Partial<LeaseRow> = {}): LeaseRow => ({
  workspace: "s1",
  sandbox: "1ctx-abc123-k3v9",
  state: "leased",
  phase: "ready",
  createdAt: 1_000,
  usedAt: 2_000,
  ...over,
});

describe("the Sandbox words", () => {
  test("the body takes empty as none and checks what the server checks", () => {
    expect(sandboxBody(draftOf(settings))).toEqual({
      body: {
        backend: "openshell",
        endpoint: "https://127.0.0.1:17671",
        image: null,
      },
    });
    const d = draftOf(settings);
    expect(sandboxBody({ ...d, endpoint: " " })).toMatchObject({
      field: "endpoint",
    });
    expect(sandboxBody({ ...d, backend: "builtin", endpoint: "" })).toEqual({
      body: { backend: "builtin", endpoint: null, image: null },
    });
    expect(
      sandboxBody({ ...d, endpoint: "http://127.0.0.1:17671" }),
    ).toMatchObject({ field: "endpoint" });
    expect(sandboxBody({ ...d, image: "a b" })).toMatchObject({
      field: "image",
    });
    expect(sandboxBody({ ...d, image: " 1ctx-shell:dev " })).toMatchObject({
      body: { image: "1ctx-shell:dev" },
    });
  });

  test("dirty only when a field differs from the saved row", () => {
    expect(sandboxDirty(draftOf(settings), settings)).toBe(false);
    expect(
      sandboxDirty({ ...draftOf(settings), backend: "builtin" }, settings),
    ).toBe(true);
  });

  test("a server refusal lands at its field", () => {
    expect(sandboxFieldOf("the sandbox shell needs a gateway endpoint")).toBe(
      "endpoint",
    );
    expect(
      sandboxFieldOf(
        "the sandbox shell needs openshell-gateway-ca.key, openshell-gateway-cert.key, openshell-gateway-key.key",
      ),
    ).toBe("backend");
    expect(sandboxFieldOf("image must be null or an image reference")).toBe(
      "image",
    );
    expect(sandboxFieldOf("something else")).toBeUndefined();
  });

  test("says which shell is picked and why the sandbox one is off", () => {
    expect(backendLine("openshell")).toBe(
      "Commands run in an OpenShell sandbox, one per chat or run.",
    );
    expect(backendLine("builtin")).toBe(
      "Commands run in the built-in shell, inside the server.",
    );
    expect(BACKEND_OPTIONS.map((o) => o.label)).toEqual([
      "Built-in",
      "OpenShell",
    ]);
    expect(offLine(response())).toBeNull();
    expect(
      offLine(
        response({ active: false, keys: { ca: true, cert: true, key: false } }),
      ),
    ).toBe("The sandbox shell is off: openshell-gateway-key.key is missing.");
    expect(
      offLine(
        response({
          active: false,
          keys: { ca: false, cert: false, key: true },
        }),
      ),
    ).toBe(
      "The sandbox shell is off: openshell-gateway-ca.key, openshell-gateway-cert.key are missing.",
    );
    expect(
      offLine(
        response({
          settings: { ...settings, backend: "builtin" },
          active: false,
          keys: { ca: false, cert: false, key: false },
        }),
      ),
    ).toBeNull();
  });

  test("the network draft: the defaults while none are saved, off keeps the list", () => {
    expect(netDraftOf(settings)).toEqual({
      mode: "hosts",
      text: DEFAULTS_TEXT,
    });
    expect(netDraftOf({ ...settings, hosts: ["a.test"] })).toEqual({
      mode: "hosts",
      text: "a.test",
    });
    expect(NET_DEFAULTS).toEqual({ mode: "hosts", text: DEFAULTS_TEXT });
    // the defaults go back as null, any order
    const reversed = [...SANDBOX_DEFAULT_HOSTS].reverse().join("\n");
    expect(netBody({ mode: "hosts", text: reversed })).toEqual({
      body: { network: "hosts", hosts: null },
    });
    expect(netAtDefaults({ mode: "hosts", text: reversed })).toBe(true);
    expect(netAtDefaults({ mode: "off", text: DEFAULTS_TEXT })).toBe(false);
    expect(netAtDefaults({ mode: "hosts", text: "a.test" })).toBe(false);
    expect(netBody({ mode: "hosts", text: "B.test\n*.a.example.com" })).toEqual(
      { body: { network: "hosts", hosts: ["*.a.example.com", "b.test"] } },
    );
    expect(netBody({ mode: "off", text: "junk here" })).toEqual({
      body: { network: "off" },
    });
    expect(netBody({ mode: "hosts", text: "a.test\n*.com" })).toEqual({
      error: "Line 2, *.com, needs three labels as a wildcard.",
    });
    expect(netBody({ mode: "hosts", text: " \n" })).toEqual({
      error: "List at least one host.",
    });
    expect(netCount(DEFAULTS_TEXT)).toBe(
      `${SANDBOX_DEFAULT_HOSTS.length} of 200`,
    );
    expect(netCount("a.test\nhttp://x/y")).toBe("2 of 200");
    const saved = { ...settings, network: "off" as const };
    expect(netDirty({ mode: "off", text: "x" }, saved)).toBe(false);
    expect(netDirty({ mode: "hosts", text: DEFAULTS_TEXT }, saved)).toBe(true);
    expect(
      netDirty({ mode: "hosts", text: `${DEFAULTS_TEXT}\n` }, settings),
    ).toBe(false);
    expect(netFieldOf('hosts: "*.com" needs three labels as a wildcard')).toBe(
      "hosts",
    );
    expect(netFieldOf("the hosts network needs a host at least")).toBe("hosts");
    expect(netFieldOf("backend must be builtin or openshell")).toBeUndefined();
  });

  test("a project on openshell without a working gateway is named, and no sandbox is claimed", () => {
    const builtinWith = (over: Partial<SandboxResponse>) =>
      response({
        settings: { ...settings, backend: "builtin" },
        active: false,
        ...over,
      });
    const one = { builtin: 0, openshell: 1 };
    expect(
      offLine(
        builtinWith({
          settings: { ...settings, backend: "builtin", endpoint: null },
          overrides: one,
        }),
      ),
    ).toBe(
      "1 project on openshell runs the built-in shell until a gateway is saved.",
    );
    expect(
      offLine(
        builtinWith({
          settings: { ...settings, backend: "builtin", endpoint: null },
          overrides: { builtin: 0, openshell: 2 },
        }),
      ),
    ).toBe(
      "2 projects on openshell run the built-in shell until a gateway is saved.",
    );
    const keyless = builtinWith({
      overrides: one,
      keys: { ca: true, cert: true, key: false },
    });
    expect(offLine(keyless)).toBe(
      "The sandbox shell is off: openshell-gateway-key.key is missing.",
    );
    expect(sandboxOn(keyless)).toBe(false);
    expect(offLine(builtinWith({ overrides: one }))).toBeNull();
    expect(sandboxOn(builtinWith({ overrides: one }))).toBe(true);
    expect(sandboxOn(builtinWith({}))).toBe(false);
    expect(sandboxOn(response())).toBe(true);
  });

  test("counts the projects that pick their own shell, and keeps the gateway for their openshell", () => {
    expect(overridesLine({ builtin: 0, openshell: 0 })).toBeNull();
    expect(overridesLine({ builtin: 0, openshell: 1 })).toBe(
      "1 project picks its own shell: 1 on OpenShell.",
    );
    expect(overridesLine({ builtin: 2, openshell: 1 })).toBe(
      "3 projects pick their own shell: 2 on Built-in, 1 on OpenShell.",
    );
    expect(gatewayShown("openshell", { builtin: 0, openshell: 0 })).toBe(true);
    expect(gatewayShown("builtin", { builtin: 3, openshell: 0 })).toBe(false);
    expect(gatewayShown("builtin", { builtin: 0, openshell: 1 })).toBe(true);
  });

  test("a lease names its chat and phase, a stuck one its next step", () => {
    expect(leaseSub(lease())).toBe("s1 · ready");
    expect(leaseSub(lease({ workspace: null, phase: null }))).toBe(
      "No chat yet",
    );
    expect(stuckLine(lease())).toBeNull();
    expect(stuckLine(lease({ state: "stuck", phase: "error" }))).toContain(
      "Docker host",
    );
    expect(stuckLine(lease({ state: "stuck", phase: "deleting" }))).toContain(
      "counts against the cap",
    );
    expect(
      leaseCounts([
        lease(),
        lease({ state: "idle" }),
        lease({ state: "warm" }),
        lease({ state: "stuck" }),
      ]),
    ).toEqual({ inUse: 2, warm: 1, stuck: 1 });
  });
});

describe("the Sandbox page", () => {
  afterEach(() => {
    sandbox.value = null;
    sandboxError.value = null;
    sandboxLeases.value = null;
    sandboxLeasesError.value = null;
    sandboxRefused.value = null;
  });

  test("Config lists it right after Web access", () => {
    const config = ZONES.find((z) => z.label === "Config")!;
    const labels = config.pages.map((p) => p.label);
    expect(labels[labels.indexOf("Web access") + 1]).toBe("Sandbox");
    expect(config.pages.find((p) => p.label === "Sandbox")?.href).toBe(
      "/admin/config/sandbox",
    );
  });

  test.serial("the form, the key files by name, the sandboxes", () => {
    sandbox.value = response();
    sandboxLeases.value = [
      lease(),
      lease({ sandbox: "1ctx-abc123-zz", state: "stuck", phase: "error" }),
    ];
    const html = render(<Sandbox />);
    expect(html.match(/<form\b/g)).toHaveLength(2);
    expect(
      [...html.matchAll(/setting-title">([^<]+)</g)].map((m) => m[1]),
    ).toEqual(["Shell", "Network", "Sandboxes"]);
    expect(html).toContain(">OpenShell</button>");
    expect(html).toContain(
      "Commands run in an OpenShell sandbox, one per chat or run.",
    );
    // no list saved: the defaults, counted
    expect(html).toContain(
      `setting-count">${SANDBOX_DEFAULT_HOSTS.length} of 200<`,
    );
    expect(html).toMatch(/<textarea name="hosts"[^>]*>/);
    expect(html).toContain(`>${DEFAULTS_TEXT}</textarea>`);
    expect(html).toContain(HOSTS_HINT);
    expect(html).toContain("while Web access is on.");
    // already the defaults: nothing for the button to do
    expect(html).toMatch(
      /<button type="button" class="btn btn-small" disabled>Use defaults/,
    );
    for (const name of ["endpoint", "image"]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain('value="https://127.0.0.1:17671"');
    expect(html).toContain('placeholder="ghcr.io/stefanprodan/1ctx-shell:dev"');
    expect(html).toContain("openshell-gateway-ca.key");
    expect(html).toContain("1ctx-abc123");
    expect(html).toContain("1ctx-abc123-k3v9");
    expect(html).toContain("Running");
    expect(html).toContain("Stuck");
    expect(html).toContain("Remove its containers and volumes");
    expect(html).not.toContain("Unsaved changes");
    expect(html).not.toContain("setting-alert");
  });

  test.serial(
    "the built-in shell hides the gateway, the image and the network",
    () => {
      sandbox.value = response({
        settings: { ...settings, backend: "builtin" },
        active: false,
      });
      sandboxLeases.value = [];
      const html = render(<Sandbox />);
      expect(html).toContain('name="backend"');
      for (const name of ["endpoint", "image", "hosts", "network"]) {
        expect(html).not.toContain(`name="${name}"`);
      }
      expect(html).not.toContain("Use defaults");
      expect(html).toContain(
        "Commands run in the built-in shell, inside the server.",
      );
    },
  );

  test.serial(
    "a project on openshell keeps the gateway, the image and the network under the built-in shell",
    () => {
      sandbox.value = response({
        settings: { ...settings, backend: "builtin" },
        active: false,
        overrides: { builtin: 0, openshell: 1 },
      });
      sandboxLeases.value = [];
      const html = render(<Sandbox />);
      for (const name of ["endpoint", "image", "hosts"]) {
        expect(html).toContain(`name="${name}"`);
      }
      expect(html).toContain(
        "Commands run in the built-in shell, inside the server. 1 project picks its own shell: 1 on OpenShell.",
      );
      expect(html).toContain("No sandboxes yet.");
    },
  );

  test.serial("off hides the hosts and their count", () => {
    sandbox.value = response({
      settings: { ...settings, network: "off", hosts: ["a.test"] },
    });
    sandboxLeases.value = [];
    const html = render(<Sandbox />);
    expect(html).toContain('name="network"');
    expect(html).not.toContain('name="hosts"');
    expect(html).not.toContain("of 200");
    expect(html).toMatch(
      /<button type="button" class="btn btn-small">Use defaults/,
    );
  });

  test.serial("says the shell is off and that there are no sandboxes", () => {
    sandbox.value = response({
      active: false,
      keys: { ca: true, cert: false, key: true },
    });
    sandboxLeases.value = [];
    const html = render(<Sandbox />);
    expect(html).toContain("openshell-gateway-cert.key is missing.");
    expect(html).toContain("No sandboxes. The built-in shell runs.");
    expect(html).toMatch(/>missing</);
  });

  test.serial("says why every command is refused", () => {
    sandbox.value = response();
    sandboxLeases.value = [];
    sandboxRefused.value =
      "the sandbox image img fails its root check (missing /repos). An admin must fix the image or pick another";
    const html = render(<Sandbox />);
    expect(html).toContain("setting-alert");
    expect(html).toContain(
      "Every OpenShell command is refused: the sandbox image img fails its root check (missing /repos). An admin must fix the image or pick another.",
    );
  });
});

function draw(drafted: Signal<SandboxDraft | null>) {
  const inputs: Record<string, (e: Event) => void> = {};
  const picks: Record<string, (value: string) => void> = {};
  const submits: ((e: Event) => void)[] = [];
  const saves: Save[] = [];
  let defaults: (() => void) | undefined;
  const previous = options.vnode;
  options.vnode = (v) => {
    previous?.(v);
    const props = v.props as Record<string, unknown>;
    if (
      (v.type === "input" || v.type === "textarea") &&
      typeof props.name === "string"
    ) {
      inputs[props.name] = props.onInput as (e: Event) => void;
    }
    if (typeof props.onPick === "function" && typeof props.name === "string") {
      picks[props.name] = props.onPick as (value: string) => void;
    }
    if (v.type === "button" && props.children === "Use defaults") {
      defaults = props.onClick as () => void;
    }
    if (v.type === "form") submits.push(props.onSubmit as (e: Event) => void);
    if (props.save instanceof Save && !saves.includes(props.save))
      saves.push(props.save);
  };
  let html: string;
  try {
    html = render(<SandboxCards state={sandbox.value!} drafted={drafted} />);
  } finally {
    options.vnode = previous;
  }
  return {
    html,
    type: (name: string, value: string) =>
      inputs[name]!({ currentTarget: { value } } as unknown as Event),
    pick: (name: string, value: string) => picks[name]!(value),
    useDefaults: () => defaults!(),
    // the Shell card's form first, then the Network card's
    submit: (n = 0) => submits[n]!(new Event("submit", { cancelable: true })),
    save: saves[0]!,
    saves,
  };
}

describe("the Sandbox page flows", () => {
  const calls = deferredFetch();
  const sentBody = (n: number) => JSON.parse(String(calls[n]!.init?.body));

  afterEach(() => {
    sandbox.value = null;
    sandboxError.value = null;
    sandboxLeases.value = null;
    sandboxLeasesError.value = null;
  });

  test.serial("loads the setting and the sandboxes", async () => {
    const loading = loadSandbox();
    expect(calls.map((c) => c.url).sort()).toEqual([
      "/api/admin/sandbox",
      "/api/admin/sandbox/leases",
    ]);
    for (const call of calls) {
      call.answer(
        call.url.endsWith("/leases")
          ? Response.json({ leases: [lease()] })
          : Response.json(response()),
      );
    }
    await loading;
    expect(sandbox.value).toEqual(response());
    expect(sandboxLeases.value).toEqual([lease()]);
  });

  test.serial("a save sends the draft, then reads the sandboxes", async () => {
    sandbox.value = response();
    const drafted = signal<SandboxDraft | null>(null);
    draw(drafted).type("image", "1ctx-shell:dev");
    const edited = draw(drafted);
    expect(edited.html).toContain("Unsaved changes");
    edited.submit();
    await settle();
    expect(calls[0]!.url).toBe("/api/admin/sandbox");
    expect(calls[0]!.init?.method).toBe("PUT");
    expect(sentBody(0)).toEqual({
      backend: "openshell",
      endpoint: "https://127.0.0.1:17671",
      image: "1ctx-shell:dev",
    });
    calls[0]!.answer(
      Response.json(
        response({ settings: { ...settings, image: "1ctx-shell:dev" } }),
      ),
    );
    await settle();
    expect(edited.save.status.value).toBe("done");
    expect(drafted.value).toBeNull();
    expect(calls[1]!.url).toBe("/api/admin/sandbox/leases");
    calls[1]!.answer(Response.json({ leases: [] }));
    await settle();
    expect(sandboxLeases.value).toEqual([]);
    edited.save.dispose();
  });

  test.serial("a refused save lands at its field", async () => {
    sandbox.value = response({
      settings: { ...settings, backend: "builtin" },
      active: false,
    });
    const drafted = signal<SandboxDraft | null>({
      ...draftOf(settings),
      backend: "openshell",
    });
    const edited = draw(drafted);
    edited.submit();
    await settle();
    calls[0]!.answer(
      Response.json(
        {
          error:
            "the sandbox shell needs openshell-gateway-ca.key, openshell-gateway-cert.key, openshell-gateway-key.key",
        },
        { status: 400 },
      ),
    );
    await settle();
    expect(edited.save.fieldError("backend")).toContain(
      "openshell-gateway-ca.key",
    );
    expect(drafted.value?.backend).toBe("openshell");
    edited.save.dispose();
  });
});

describe("the Network card's flows", () => {
  const calls = deferredFetch();
  const sentBody = (n: number) => JSON.parse(String(calls[n]!.init?.body));

  afterEach(() => {
    sandbox.value = null;
    sandboxLeases.value = null;
    sandboxLeasesError.value = null;
    sandboxRefused.value = null;
  });

  // a save reads the sandboxes after it
  const answerLeases = async (n: number) => {
    expect(calls[n]!.url).toBe("/api/admin/sandbox/leases");
    calls[n]!.answer(Response.json({ leases: [], refused: null }));
    await settle();
  };

  test.serial(
    "a builtin draft hides the card and says the built-in line",
    () => {
      sandbox.value = response();
      const drafted = signal<SandboxDraft | null>(null);
      draw(drafted).pick("backend", "builtin");
      const html = draw(drafted).html;
      expect(html).not.toContain('name="hosts"');
      expect(html).toContain(
        "Commands run in the built-in shell, inside the server.",
      );
      expect(html).not.toContain("one per chat or run");
    },
  );

  // the cards mounted, their hooks kept, with the latest render's
  // handlers at hand
  async function mounted() {
    const on: {
      hosts?: (e: Event) => void;
      network?: (value: string) => void;
      defaults?: () => void;
      submits: ((e: Event) => void)[];
    } = { submits: [] };
    const previous = options.vnode;
    options.vnode = (v) => {
      previous?.(v);
      const props = v.props as Record<string, unknown>;
      if (v.type === "textarea" && props.name === "hosts")
        on.hosts = props.onInput as (e: Event) => void;
      if (props.name === "network" && typeof props.onPick === "function")
        on.network = props.onPick as (value: string) => void;
      if (v.type === "button" && props.children === "Use defaults")
        on.defaults = props.onClick as () => void;
      if (v.type === "form")
        on.submits.push(props.onSubmit as (e: Event) => void);
    };
    // a refused check focuses its field by a selector
    const g = globalThis as { CSS?: unknown };
    const css = g.CSS;
    g.CSS = { escape: (text: string) => text };
    const view = await mount(
      <SandboxCards state={sandbox.value!} drafted={signal(null)} />,
    );
    return {
      view,
      on,
      // the Network card's form is the second of the latest render's
      submitNetwork: () =>
        act(() =>
          on.submits.at(-1)!(new Event("submit", { cancelable: true })),
        ),
      async done() {
        await view.unmount();
        options.vnode = previous;
        if (css === undefined) delete g.CSS;
        else g.CSS = css;
      },
    };
  }

  test.serial(
    "Use defaults fills the draft without saving, then the save sends null",
    async () => {
      sandbox.value = response({
        settings: { ...settings, network: "off", hosts: ["a.test"] },
      });
      const t = await mounted();
      try {
        expect(t.view.html()).not.toContain('name="hosts"');
        await act(() => t.on.defaults!());
        const html = t.view.html();
        expect(calls).toHaveLength(0);
        expect(html).toContain("Unsaved changes");
        expect(html).toContain("*.githubusercontent.com\n");
        expect(html).toContain(
          `setting-count">${SANDBOX_DEFAULT_HOSTS.length} of 200<`,
        );
        expect(html).toMatch(
          /class="btn btn-small" disabled[^>]*>Use defaults/,
        );
        await t.submitNetwork();
        await settle();
        expect(calls[0]!.init?.method).toBe("PUT");
        expect(sentBody(0)).toEqual({ network: "hosts", hosts: null });
        calls[0]!.answer(Response.json(response()));
        await settle();
        await answerLeases(1);
      } finally {
        await t.done();
      }
    },
  );

  test.serial(
    "hosts typed go out sorted, and a bad line is named",
    async () => {
      sandbox.value = response({
        settings: { ...settings, hosts: ["a.test"] },
      });
      const t = await mounted();
      try {
        expect(t.view.html()).toContain('value="a.test"></textarea>');
        expect(t.view.html()).toContain('setting-count">1 of 200<');
        const type = (value: string) =>
          act(() =>
            t.on.hosts!({ currentTarget: { value } } as unknown as Event),
          );
        await type("a.test\n*.com");
        await t.submitNetwork();
        expect(calls).toHaveLength(0);
        expect(t.view.html()).toContain(
          "Line 2, *.com, needs three labels as a wildcard.",
        );
        await type("pypi.org\n*.githubusercontent.com");
        await t.submitNetwork();
        await settle();
        expect(sentBody(0)).toEqual({
          network: "hosts",
          hosts: ["*.githubusercontent.com", "pypi.org"],
        });
        calls[0]!.answer(Response.json(response()));
        await settle();
        await answerLeases(1);
      } finally {
        await t.done();
      }
    },
  );
});

describe("the Sandbox list's poll", () => {
  const calls = deferredFetch();

  afterEach(() => {
    sandbox.value = null;
    sandboxLeases.value = null;
    sandboxLeasesError.value = null;
    sandboxRefused.value = null;
  });

  test.serial(
    "reads the list each period while seen, never hidden",
    async () => {
      const fake = pollTab(LEASES_EVERY_MS);
      const stop = watchSandboxLeases(fake.tab);
      expect(calls).toHaveLength(0);
      fake.tick();
      expect(calls.map((c) => c.url)).toEqual(["/api/admin/sandbox/leases"]);
      calls[0]!.answer(
        Response.json({ leases: [lease()], refused: "a global policy" }),
      );
      await settle();
      expect(sandboxLeases.value).toEqual([lease()]);
      expect(sandboxRefused.value).toBe("a global policy");
      fake.set("hidden");
      fake.tick();
      expect(calls).toHaveLength(1);
      fake.set("visible");
      expect(calls).toHaveLength(2);
      calls[1]!.answer(Response.json({ error: "gone" }, { status: 502 }));
      await settle();
      // a failed read keeps the last list and says so, and drops the
      // refusal it can no longer vouch for
      expect(sandboxLeases.value).toEqual([lease()]);
      expect(sandboxLeasesError.value).not.toBeNull();
      expect(sandboxRefused.value).toBeNull();
      stop();
      expect(fake.timers()).toBe(0);
      expect(fake.listeners()).toBe(0);
    },
  );

  test.serial("the page stops its poll when it goes", async () => {
    sandbox.value = response();
    sandboxLeases.value = [lease()];
    sandboxLeasesError.value = { words: "gone", status: 502 };
    const fake = pollTab(LEASES_EVERY_MS);
    const view = await mount(<SandboxView tab={fake.tab} />);
    try {
      expect(fake.timers()).toBe(1);
      expect(fake.listeners()).toBe(1);
      expect(view.html()).toContain("The list could not be read again.");
      expect(view.html()).toContain("1ctx-abc123-k3v9");
    } finally {
      await view.unmount();
    }
    expect(fake.timers()).toBe(0);
    expect(fake.listeners()).toBe(0);
  });
});
