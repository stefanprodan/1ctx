// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { options, type VNode } from "preact";
import { render } from "preact-render-to-string";
import { App } from "../../../src/client/app/App.tsx";
import { path } from "../../../src/client/app/router.ts";
import { emailOn, me } from "../../../src/client/data/me.ts";
import { passkeys } from "../../../src/client/data/passkeys.ts";
import {
  SplitButton,
  type SplitItem,
} from "../../../src/client/ui/SplitButton.tsx";
import { PasskeyStep } from "../../../src/client/views/home/PasskeyStep.tsx";
import { KEPT_WAY } from "../../../src/client/views/home/SignIn.model.ts";
import { SignIn } from "../../../src/client/views/home/SignIn.tsx";
import { withClass } from "../../helpers/classes.ts";
import { deferredFetch } from "../../helpers/client-fetch.ts";

// a closed menu renders no items, so they are read off its props
function menusOf(node: VNode): { label: string; items: SplitItem[] }[] {
  const seen: { label: string; items: SplitItem[] }[] = [];
  const was = options.vnode;
  options.vnode = (v) => {
    if (v.type === SplitButton) {
      seen.push(v.props as unknown as (typeof seen)[number]);
    }
    was?.(v);
  };
  try {
    render(node);
  } finally {
    options.vnode = was;
  }
  return seen;
}

const labels = (items: SplitItem[]) =>
  items.map((i) => `${i.label}${i.checked ? " (picked)" : ""}`);

const button = (html: string, label: string) =>
  new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}`).exec(html)![0];

describe("the sign-in with passkeys", () => {
  const g = globalThis as Record<string, unknown>;
  const held = {
    support: passkeys.support.peek(),
    autofill: passkeys.autofill.peek(),
    localStorage: g.localStorage,
  };
  let kept: Map<string, string>;
  // options never answered: the buttons wait for them
  const asked = deferredFetch();

  beforeEach(() => {
    kept = new Map();
    g.localStorage = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => kept.set(k, v),
    };
    passkeys.support.value = true;
  });
  afterEach(() => {
    passkeys.support.value = held.support;
    passkeys.autofill.value = held.autofill;
    passkeys.signedOut();
    g.localStorage = held.localStorage;
    emailOn.value = false;
  });

  test.serial(
    "with email, passkeys and autofill: one Sign in, three ways, and the field offers passkeys",
    () => {
      emailOn.value = true;
      passkeys.autofill.value = true;
      const html = render(<SignIn />);
      expect(html).toContain('autocomplete="email webauthn"');
      const menus = menusOf(<SignIn />);
      expect(menus.map((x) => x.label)).toEqual(["Ways to sign in"]);
      expect(labels(menus[0]!.items)).toEqual([
        "Email code (picked)",
        "Passkey",
        "Admin key",
      ]);
    },
  );

  test.serial("without autofill the fields autocomplete as before", () => {
    emailOn.value = true;
    passkeys.autofill.value = false;
    const html = render(<SignIn />);
    expect(html).toContain('autocomplete="email"');
    expect(html).not.toContain("webauthn");
    emailOn.value = false;
    const key = render(<SignIn />);
    expect(key).toContain('autocomplete="current-password"');
    expect(key).not.toContain("webauthn");
  });

  test.serial(
    "with email off there is no email way, and the key field offers passkeys",
    () => {
      passkeys.autofill.value = true;
      const html = render(<SignIn />);
      expect(html).toContain(">Admin key</span>");
      expect(html).not.toContain('type="email"');
      expect(html).toContain('autocomplete="current-password webauthn"');
      expect(labels(menusOf(<SignIn />)[0]!.items)).toEqual([
        "Passkey",
        "Admin key (picked)",
      ]);
    },
  );

  test.serial("a browser without passkeys has no passkey way", () => {
    passkeys.support.value = false;
    emailOn.value = true;
    expect(labels(menusOf(<SignIn />)[0]!.items)).toEqual([
      "Email code (picked)",
      "Admin key",
    ]);
  });

  test.serial(
    "the passkey way asks on Sign in, which waits for its options",
    () => {
      emailOn.value = true;
      kept.set(KEPT_WAY, "passkey");
      const ready = render(<SignIn />);
      expect(ready).toContain(
        "Use Face ID, Touch ID or your password manager.",
      );
      expect(ready).not.toContain('type="email"');
      expect(button(ready, "Sign in")).not.toContain("disabled");
      // options on their way: Sign in waits, the arrow a spinner
      const release = passkeys.prime("sign_in");
      expect(asked.map((c) => c.url)).toEqual(["/api/login/passkey/options"]);
      const html = render(<SignIn />);
      release();
      expect(button(html, "Sign in")).toContain("disabled");
      expect(withClass(html, "splitbutton-spin")).toBe(1);
      expect(labels(menusOf(<SignIn />)[0]!.items)).toEqual([
        "Email code",
        "Passkey (picked)",
        "Admin key",
      ]);
      // a passkey way kept on a browser without passkeys falls back
      passkeys.support.value = false;
      expect(render(<SignIn />)).toContain('type="email"');
    },
  );

  test.serial(
    "the passkey step offers an add or a skip, the add waiting for its options",
    () => {
      const release = passkeys.prime("add");
      const html = render(<PasskeyStep />);
      release();
      expect(html).toContain("Sign in faster next time");
      expect(html).toContain(
        "Use Face ID, Touch ID or your password manager instead of a code.",
      );
      expect(button(html, "Add a passkey")).toContain("disabled");
      expect(button(html, "Skip")).not.toContain("disabled");
    },
  );

  test.serial("the app waits behind the step once signed in", () => {
    const was = path.value;
    path.value = "/profile";
    me.value = {
      id: "u1",
      username: "ana",
      fullName: "Ana",
      role: "member",
    };
    try {
      passkeys.step.value = true;
      const step = render(<App />);
      expect(step).toContain("Sign in faster next time");
      expect(step).not.toContain("shell-main");
      passkeys.step.value = false;
      expect(render(<App />)).not.toContain("Sign in faster next time");
    } finally {
      path.value = was;
      me.value = undefined;
    }
  });
});
