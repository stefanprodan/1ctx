// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Config board's Sandbox page: its words, the Shell card's draft
// and refusals against the route, the sandboxes with stuck ones named,
// and its place in the Config zone.

import { afterEach, describe, expect, test } from "bun:test";
import { type Signal, signal } from "@preact/signals";
import { options } from "preact";
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
  draftOf,
  leaseCounts,
  leaseSub,
  offLine,
  type SandboxDraft,
  sandboxBody,
  sandboxDirty,
  sandboxFieldOf,
  shellLine,
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
import { settle } from "../../helpers/async.ts";
import { deferredFetch } from "../../helpers/client-fetch.ts";
import { mount } from "../../helpers/mount.ts";
import { pollTab } from "../../helpers/poll.ts";

const settings: SandboxSettings = {
  shell: "sandbox",
  endpoint: "https://127.0.0.1:17671",
  image: null,
  instanceId: "abc123",
  updatedAt: 5,
};

const response = (over: Partial<SandboxResponse> = {}): SandboxResponse => ({
  settings,
  defaultImage: "ghcr.io/stefanprodan/1ctx-shell:dev",
  gatewayLabel: "1ctx-abc123",
  keys: { ca: true, cert: true, key: true },
  active: true,
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
        shell: "sandbox",
        endpoint: "https://127.0.0.1:17671",
        image: null,
      },
    });
    const d = draftOf(settings);
    expect(sandboxBody({ ...d, endpoint: " " })).toMatchObject({
      field: "endpoint",
    });
    expect(sandboxBody({ ...d, shell: "builtin", endpoint: "" })).toEqual({
      body: { shell: "builtin", endpoint: null, image: null },
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
      sandboxDirty({ ...draftOf(settings), shell: "builtin" }, settings),
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
    ).toBe("shell");
    expect(sandboxFieldOf("image must be null or an image reference")).toBe(
      "image",
    );
    expect(sandboxFieldOf("something else")).toBeUndefined();
  });

  test("says which shell runs and why the sandbox one is off", () => {
    expect(shellLine(response())).toContain("OpenShell sandbox");
    expect(shellLine(response({ active: false }))).toContain("built-in shell");
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
          settings: { ...settings, shell: "builtin" },
          active: false,
          keys: { ca: false, cert: false, key: false },
        }),
      ),
    ).toBeNull();
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
    expect(html.match(/<form\b/g)).toHaveLength(1);
    expect(
      [...html.matchAll(/setting-title">([^<]+)</g)].map((m) => m[1]),
    ).toEqual(["Shell", "Sandboxes"]);
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

  test.serial("the built-in shell hides the gateway and the image", () => {
    sandbox.value = response({
      settings: { ...settings, shell: "builtin" },
      active: false,
    });
    sandboxLeases.value = [];
    const html = render(<Sandbox />);
    expect(html).toContain('name="shell"');
    for (const name of ["endpoint", "image"]) {
      expect(html).not.toContain(`name="${name}"`);
    }
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
      "Every command is refused: the sandbox image img fails its root check (missing /repos). An admin must fix the image or pick another.",
    );
  });
});

function draw(drafted: Signal<SandboxDraft | null>) {
  const inputs: Record<string, (e: Event) => void> = {};
  let submit: ((e: Event) => void) | undefined;
  let save: Save | undefined;
  const previous = options.vnode;
  options.vnode = (v) => {
    previous?.(v);
    const props = v.props as Record<string, unknown>;
    if (v.type === "input" && typeof props.name === "string") {
      inputs[props.name] = props.onInput as (e: Event) => void;
    }
    if (v.type === "form") submit = props.onSubmit as (e: Event) => void;
    if (props.save instanceof Save) save = props.save;
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
    submit: () => submit!(new Event("submit", { cancelable: true })),
    save: save!,
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
      shell: "sandbox",
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
      settings: { ...settings, shell: "builtin" },
      active: false,
    });
    const drafted = signal<SandboxDraft | null>({
      ...draftOf(settings),
      shell: "sandbox",
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
    expect(edited.save.fieldError("shell")).toContain(
      "openshell-gateway-ca.key",
    );
    expect(drafted.value?.shell).toBe("sandbox");
    edited.save.dispose();
  });
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
