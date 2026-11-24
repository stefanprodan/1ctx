// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { passkeys } from "../../../src/client/data/passkeys.ts";
import { profile } from "../../../src/client/data/profile.ts";
import {
  elsewhere,
  passkeyLines,
} from "../../../src/client/views/profile/Passkeys.model.ts";
import { PasskeysSection } from "../../../src/client/views/profile/Passkeys.tsx";
import { Profile } from "../../../src/client/views/profile/Profile.tsx";
import type { Passkey } from "../../../src/shared/api/profile.ts";
import { settle } from "../../helpers/async.ts";
import { withClass } from "../../helpers/classes.ts";
import { clientFetch } from "../../helpers/client-fetch.ts";
import { mount } from "../../helpers/mount.ts";

const ORIGIN = "https://1ctx.example.com";
const LOCAL = "http://localhost:11236";
const NOW = new Date(2026, 10, 24, 12).getTime();

const item = (over: Partial<Passkey> = {}): Passkey => ({
  id: "pk1",
  credentialId: "Y3JlZC0x",
  origin: ORIGIN,
  device: "Apple Passwords",
  createdAt: new Date(2026, 10, 12, 9).getTime(),
  lastUsedAt: null,
  ...over,
});

describe("the passkeys' lines", () => {
  test("name the address a passkey of another origin signs in at, port included", () => {
    expect(elsewhere(item(), ORIGIN)).toBeNull();
    expect(elsewhere(item({ origin: LOCAL }), ORIGIN)).toBe("localhost:11236");
    expect(elsewhere(item({ origin: LOCAL }), "http://localhost:3000")).toBe(
      "localhost:11236",
    );
  });

  test("name the day added and the day last used, or never", () => {
    expect(passkeyLines(item(), NOW)).toEqual({
      added: "Added 12 Nov",
      used: "Never used",
    });
    expect(
      passkeyLines(
        item({
          createdAt: new Date(2025, 2, 2, 10).getTime(),
          lastUsedAt: new Date(2026, 10, 20, 23).getTime(),
        }),
        NOW,
      ),
    ).toEqual({ added: "Added 2 Mar 2025", used: "Last used 20 Nov" });
  });
});

describe("the Passkeys section", () => {
  const was = passkeys.support.peek();
  afterEach(() => {
    passkeys.support.value = was;
    passkeys.list.value = null;
    passkeys.failed.value = null;
    profile.value = null;
  });

  const user = () => {
    profile.value = {
      id: "u1",
      username: "casey",
      fullName: "Casey Doe",
      email: "casey@example.com",
      tz: "Europe/Bucharest",
      disabled: false,
      signedInAt: null,
      emailPlaceholder: false,
      emailFromAgents: false,
      about: "",
      role: "member",
      createdAt: new Date(2026, 8, 12).getTime(),
    };
  };

  test.serial("is absent where the browser has no WebAuthn", () => {
    user();
    passkeys.support.value = false;
    const html = render(<Profile />);
    expect(html).toContain('autocomplete="name"');
    expect(html).not.toContain("Passkeys");
    expect(html).not.toContain("Add a passkey");
  });

  test.serial(
    "lists every passkey, another address's named, with Remove and Add",
    () => {
      user();
      passkeys.support.value = true;
      passkeys.list.value = [
        item(),
        item({
          id: "pk2",
          origin: LOCAL,
          device: "Windows Hello",
          lastUsedAt: Date.now(),
        }),
      ];
      // the page's own address, which the rows are read against
      const g = globalThis as Record<string, unknown>;
      const had = g.location;
      g.location = { origin: ORIGIN, hostname: "1ctx.example.com" };
      let html: string;
      try {
        html = render(<Profile />);
      } finally {
        g.location = had;
      }
      expect(html).toContain(">Passkeys</h2>");
      expect(html).toContain(
        "Use Face ID, Touch ID or your password manager instead of a code.",
      );
      expect(html).toContain("Apple Passwords");
      expect(html).toContain("Added ");
      expect(html).toContain("Never used");
      // a passkey added elsewhere, as a stolen login could, never hides
      expect(html).toContain("Windows Hello");
      expect(html).toContain("Last used ");
      expect(html).toContain("localhost:11236");
      expect(html).not.toContain("1ctx.example.com");
      expect(withClass(html, "profile-when")).toBe(5);
      expect(html.match(/>Remove<\/button>/g)).toHaveLength(2);
      expect(html).toContain('aria-label="Remove Apple Passwords"');
      expect(html).toContain('aria-label="Remove Windows Hello"');
      expect(html).toContain("Add a passkey");
    },
  );

  test.serial("with none, says so once, the hint saying what for", () => {
    user();
    passkeys.support.value = true;
    passkeys.list.value = [];
    const html = render(<Profile />);
    expect(html).toContain("No passkeys yet.");
    expect(html).not.toContain("Sign in with Face ID");
    expect(html.match(/Face ID/g)).toHaveLength(1);
    expect(html).toContain("Add a passkey");
  });

  test.serial(
    "once drawn, a retry of the list never puts the page back to bones",
    async () => {
      user();
      passkeys.support.value = true;
      passkeys.failed.value = { words: "the server failed", status: 500 };
      const m = await mount(<Profile />);
      try {
        expect(m.html()).toContain("The server failed.");
        expect(m.html()).toContain('name="about"');
        // a retry that clears the failure before its answer lands
        passkeys.failed.value = null;
        await settle();
        expect(m.html()).toContain('name="about"');
        expect(m.html()).not.toMatch(/role="status" aria-label="Loading/);
        passkeys.list.value = [item()];
        await settle();
        expect(m.html()).toContain("Apple Passwords");
      } finally {
        await m.unmount();
      }
    },
  );

  test.serial("the page waits for the passkeys with the profile", () => {
    user();
    passkeys.support.value = true;
    const html = render(<Profile />);
    expect(html).toMatch(/role="status" aria-label="Loading[^"]*"/);
    expect(html).toContain(">Passkeys</h2>");
    // a failed read is the card's to say, never a page that waits on
    passkeys.failed.value = { words: "the server failed", status: 500 };
    const failed = render(<Profile />);
    expect(failed).toContain("The server failed.");
    expect(failed).toContain("Add a passkey");
  });
});

describe("removing a passkey", () => {
  const calls = clientFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && url === "/api/profile/passkeys/options") {
      return Response.json({ challenge: "AQ", timeout: 120_000 });
    }
    if (method === "DELETE" && url === "/api/profile/passkeys/pk1") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  const was = passkeys.support.peek();
  afterEach(() => {
    passkeys.signedOut();
    passkeys.support.value = was;
  });

  test.serial("asks once, then the row goes", async () => {
    passkeys.support.value = true;
    passkeys.list.value = [item()];
    const m = await mount(<PasskeysSection />);
    try {
      await settle();
      expect(m.html()).not.toContain("Remove this passkey?");
      await m.fire("btn-small", "onClick");
      expect(m.html()).toContain("Remove this passkey?");
      expect(m.html()).toContain(">Keep</button>");
      expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
      await m.fire("btn-danger", "onClick");
      await settle();
      expect(calls.filter((c) => c.init?.method === "DELETE")).toHaveLength(1);
      expect(m.html()).not.toContain("Apple Passwords");
      expect(m.html()).toContain("No passkeys yet.");
    } finally {
      await m.unmount();
    }
  });
});
