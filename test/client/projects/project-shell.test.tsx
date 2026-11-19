// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's shell: the select's options named with the instance's
// backend, the write by the project's kind, and the select as an editor
// and a team's member see it, on the Settings tab and the admin card.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { options, type VNode } from "preact";
import { act } from "preact/test-utils";
import { render } from "preact-render-to-string";
import { me } from "../../../src/client/data/me.ts";
import { project, saveShell } from "../../../src/client/data/projects.ts";
import {
  INSTANCE_DEFAULT,
  pickedBackend,
  SHELL_ADMIN_HINT,
  SHELL_TEXT,
  shellOptions,
  shellValue,
} from "../../../src/client/views/projects/ProjectShell.model.ts";
import { ProjectShell } from "../../../src/client/views/projects/ProjectShell.tsx";
import type { ProjectDetail } from "../../../src/shared/contracts/project.ts";
import { deferred, settle } from "../../helpers/async.ts";
import { clientFetch } from "../../helpers/client-fetch.ts";
import { admin } from "../../helpers/client-fixtures.ts";
import { mount } from "../../helpers/mount.ts";

const team: ProjectDetail = {
  id: "t1",
  kind: "team",
  name: "finops",
  createdAt: 0,
  memberCount: 1,
  description: "Money.",
  members: [],
  labels: [],
  chats: 0,
  knowledge: { files: 0, tokens: 0 },
  latestFiles: [],
  backend: null,
  instanceBackend: "openshell",
};
const personal: ProjectDetail = {
  ...team,
  id: "p1",
  kind: "personal",
  name: "personal",
};

let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;
const calls = clientFetch((url, init) => answer(url, init));

beforeEach(() => {
  me.value = null;
  me.value = admin();
  answer = () => Response.json({ project: team });
});

afterEach(() => {
  me.value = undefined;
  project.value = null;
});

describe("the model", () => {
  test("the instance's default comes first, named with its backend", () => {
    expect(shellOptions("builtin")).toEqual([
      { value: INSTANCE_DEFAULT, label: "Instance default (Built-in)" },
      { value: "builtin", label: "Built-in" },
      { value: "openshell", label: "OpenShell" },
    ]);
    expect(shellOptions("openshell")[0]).toEqual({
      value: INSTANCE_DEFAULT,
      label: "Instance default (OpenShell)",
    });
  });

  test("null is the default's value, and the default sends null", () => {
    expect(shellValue({ backend: null })).toBe(INSTANCE_DEFAULT);
    expect(shellValue({ backend: "builtin" })).toBe("builtin");
    expect(pickedBackend(INSTANCE_DEFAULT)).toBeNull();
    expect(pickedBackend("openshell")).toBe("openshell");
    expect(pickedBackend("builtin")).toBe("builtin");
  });
});

describe("the write", () => {
  test.serial(
    "a team project's goes to its admin route, a personal one's to the owner's",
    async () => {
      project.value = team;
      answer = () =>
        Response.json({ project: { ...team, backend: "builtin" } });
      await saveShell(team, "builtin");
      expect(calls.at(-1)!.url).toBe("/api/projects/t1");
      expect(calls.at(-1)!.init?.method).toBe("PATCH");
      expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({
        backend: "builtin",
      });
      // the answer is the detail, kept for the tab on screen
      expect(project.value?.backend).toBe("builtin");
      answer = () => Response.json({ project: personal });
      await saveShell(personal, null);
      expect(calls.at(-1)!.url).toBe("/api/profile/project");
      expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({
        backend: null,
      });
    },
  );
});

describe("the select", () => {
  test("an editor's section picks, named with the instance's backend", () => {
    const html = render(<ProjectShell project={team} section edit />);
    expect(html).toContain(">Shell<");
    expect(html).toContain(SHELL_TEXT);
    expect(html).toContain("Instance default (OpenShell)");
    expect(html).not.toContain("disabled");
    expect(html).not.toContain(SHELL_ADMIN_HINT);
  });

  test("a team's member reads the value in the select, disabled", () => {
    const html = render(
      <ProjectShell
        project={{ ...team, backend: "builtin" }}
        section
        edit={false}
      />,
    );
    expect(html).toContain("disabled");
    expect(html).toContain(SHELL_ADMIN_HINT);
    expect(html).toContain(">Built-in<");
  });

  test("the admin page's card holds the select in its head", () => {
    const html = render(<ProjectShell project={team} section={false} edit />);
    expect(html).toContain("setting-title");
    expect(html).toContain("project-shell-pick");
    expect(html).toContain(SHELL_TEXT);
  });
});

// the select's onChange, caught as the component draws it
async function mounted(node: VNode) {
  let pick: ((value: string) => void) | undefined;
  const previous = options.vnode;
  options.vnode = (v) => {
    previous?.(v);
    const props = v.props as Record<string, unknown>;
    if (props.name === "backend" && typeof props.onChange === "function") {
      pick = props.onChange as (value: string) => void;
    }
  };
  try {
    const view = await mount(node);
    return { view, pick: (value: string) => act(() => pick!(value)) };
  } finally {
    options.vnode = previous;
  }
}

describe("a pick", () => {
  test.serial(
    "a team's goes to its admin route, waits disabled, then shows the answer",
    async () => {
      const held = deferred<Response>();
      answer = () => held.promise;
      const { view, pick } = await mounted(
        <ProjectShell project={team} section edit />,
      );
      try {
        await pick("builtin");
        expect(calls.at(-1)!.url).toBe("/api/projects/t1");
        expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({
          backend: "builtin",
        });
        expect(view.html()).toContain("disabled");
        held.resolve(
          Response.json({ project: { ...team, backend: "builtin" } }),
        );
        await act(() => settle());
        expect(view.html()).not.toContain("disabled");
      } finally {
        await view.unmount();
      }
    },
  );

  test.serial("a personal project's goes to its owner's route", async () => {
    answer = () => Response.json({ project: personal });
    const { view, pick } = await mounted(
      <ProjectShell project={personal} section edit />,
    );
    try {
      await pick("openshell");
      await act(() => settle());
      expect(calls.at(-1)!.url).toBe("/api/profile/project");
      expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({
        backend: "openshell",
      });
    } finally {
      await view.unmount();
    }
    // the default sends null
    const set = await mounted(
      <ProjectShell
        project={{ ...personal, backend: "openshell" }}
        section
        edit
      />,
    );
    try {
      await set.pick(INSTANCE_DEFAULT);
      await act(() => settle());
      expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({
        backend: null,
      });
    } finally {
      await set.view.unmount();
    }
  });

  test.serial(
    "a refused pick says why on the tab and on the card",
    async () => {
      answer = () =>
        Response.json(
          { error: "backend must be builtin, openshell or null" },
          { status: 400 },
        );
      for (const section of [true, false]) {
        const { view, pick } = await mounted(
          <ProjectShell project={team} section={section} edit />,
        );
        try {
          await pick("openshell");
          await act(() => settle());
          expect(view.html()).toMatch(
            /class="(hint )?error"[^>]*>Backend must be builtin, openshell or null\./,
          );
        } finally {
          await view.unmount();
        }
      }
    },
  );
});
