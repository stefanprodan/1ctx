// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { handedOver, sendCode, whoIs } from "../../../src/client/data/links.ts";
import { emailOn, me } from "../../../src/client/data/me.ts";
import { SplitButton } from "../../../src/client/ui/SplitButton.tsx";
import {
  codeFlow,
  erase,
  holdLine,
  KEPT_WAY,
  keepWay,
  keptWay,
  oneAtATime,
  put,
  sayLine,
  typedIn,
  wayOf,
  waysOffered,
} from "../../../src/client/views/home/SignIn.model.ts";
import { SignIn } from "../../../src/client/views/home/SignIn.tsx";
import type { Me } from "../../../src/shared/contracts/user.ts";
import { withClass } from "../../helpers/classes.ts";
import { clientFetch } from "../../helpers/client-fetch.ts";

describe("the way", () => {
  test("follows what the server offers", () => {
    expect(wayOf("email", true)).toBe("email");
    expect(wayOf("code", true)).toBe("code");
    expect(wayOf("key", true)).toBe("key");
    // email off: the admin key is the one way left
    expect(wayOf("email", false)).toBe("key");
    expect(wayOf("code", false)).toBe("key");
    expect(wayOf("key", false)).toBe("key");
  });

  test("one way alone has no menu", () => {
    expect(waysOffered(true)).toEqual(["email", "key"]);
    expect(waysOffered(false)).toEqual([]);
  });

  test.serial("is kept per browser, and a throwing storage keeps none", () => {
    const g = globalThis as Record<string, unknown>;
    const held = g.localStorage;
    const store = new Map<string, string>();
    try {
      g.localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
      };
      expect(keptWay()).toBeNull();
      keepWay("key");
      expect(store.get(KEPT_WAY)).toBe("key");
      expect(keptWay()).toBe("key");
      store.set(KEPT_WAY, "passkey");
      expect(keptWay()).toBeNull();
      g.localStorage = {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      };
      expect(keptWay()).toBeNull();
      expect(() => keepWay("email")).not.toThrow();
      delete g.localStorage;
      expect(keptWay()).toBeNull();
    } finally {
      g.localStorage = held;
    }
  });
});

describe("the code boxes", () => {
  test("a typed digit moves on, never past the first empty box", () => {
    expect(put("", 0, "4")).toEqual({ value: "4", focus: 1 });
    expect(put("4", 1, "2")).toEqual({ value: "42", focus: 2 });
    expect(put("42", 5, "7")).toEqual({ value: "427", focus: 3 });
    // over a digit, in place
    expect(put("427", 1, "9")).toEqual({ value: "497", focus: 2 });
    expect(put("12345", 5, "6")).toEqual({ value: "123456", focus: 5 });
    expect(put("", 0, "a")).toBeNull();
  });

  test("a paste or the system's fill fills every box", () => {
    expect(put("12", 4, "987654")).toEqual({ value: "987654", focus: 5 });
    expect(put("", 3, " 123 456 ")).toEqual({ value: "123456", focus: 5 });
    expect(put("1", 1, "234")).toEqual({ value: "1234", focus: 4 });
  });

  test("typing over a box's digit keeps the new one", () => {
    expect(typedIn("5", "75")).toBe("7");
    expect(typedIn("5", "57")).toBe("7");
    expect(typedIn(undefined, "3")).toBe("3");
    expect(typedIn("5", "123456")).toBe("123456");
  });

  test("Backspace takes the box's digit or the one before", () => {
    expect(erase("123", 1)).toEqual({ value: "13", focus: 1 });
    expect(erase("123", 3)).toEqual({ value: "12", focus: 2 });
    expect(erase("123", 5)).toEqual({ value: "12", focus: 2 });
    expect(erase("", 0)).toBeNull();
  });
});

describe("the line under the boxes", () => {
  test("says the address, a new code, the check or the refusal", () => {
    const at = { checking: false, error: null, resent: false, email: "a@b.c" };
    expect(sayLine(at)).toBe("Sent to a@b.c");
    expect(sayLine({ ...at, resent: true })).toBe("Code sent to a@b.c");
    expect(sayLine({ ...at, error: "Wrong code." })).toBe("Wrong code.");
    expect(sayLine({ ...at, checking: true, error: "x" })).toBe("Signing in");
    expect(holdLine("a@b.c")).toBe("Code sent to a@b.c");
  });
});

describe("the code's flow", () => {
  test("a used code is never posted again: a retry reads who is in", async () => {
    const posted: string[] = [];
    let read: "in" | "nobody" | "failed" = "failed";
    const flow = codeFlow({
      post: async (code, landed) => {
        posted.push(code);
        if (code === "111111") throw new Error("wrong code");
        landed();
        throw new Error("couldn't load");
      },
      read: async () => read,
    });
    const wrong = await flow.submit("111111");
    expect(wrong.kind).toBe("wrong");
    expect(await flow.submit("222222")).toEqual({ kind: "unread" });
    expect(await flow.submit("222222")).toEqual({ kind: "unread" });
    expect(posted).toEqual(["111111", "222222"]);
    read = "in";
    expect(await flow.retry()).toEqual({ kind: "in" });
    read = "nobody";
    expect(await flow.retry()).toEqual({ kind: "wrong", error: null });
    expect(flow.accepted()).toBe(false);
  });

  test("runs one call at a time", async () => {
    let runs = 0;
    let release = () => {};
    const once = oneAtATime(async () => {
      runs++;
      await new Promise<void>((r) => {
        release = r;
      });
    });
    const first = once();
    await once();
    release();
    await first;
    expect(runs).toBe(1);
  });
});

describe("the hand-over", () => {
  test("reads the address from the fragment, or nothing", () => {
    expect(handedOver("#code=maria%40example.test")).toBe("maria@example.test");
    expect(handedOver("#code=nobody")).toBeNull();
    expect(handedOver("#code=%E0%A4%A")).toBeNull();
    expect(handedOver("#section")).toBeNull();
    expect(handedOver("")).toBeNull();
  });
});

const user = { id: "u1", username: "maria" } as unknown as Me;

describe("signing in by code", () => {
  let answer: () => Response = () => new Response("{}");
  clientFetch(() => answer());
  afterEach(() => {
    me.value = undefined;
  });

  test.serial("lands the user after the landing", async () => {
    answer = () => Response.json({ user, landing: "/" });
    const steps: string[] = [];
    await sendCode(
      { email: " maria@example.test ", code: "123456" },
      () => steps.push("landed"),
      (to) => steps.push(`go ${to}`),
    );
    expect(steps).toEqual(["landed", "go /"]);
    expect(me.value).toEqual(user);
  });

  test.serial("an unreadable answer is a used code", async () => {
    answer = () => new Response("not json");
    let landed = false;
    await expect(
      sendCode(
        { email: "maria@example.test", code: "123456" },
        () => {
          landed = true;
        },
        () => {},
      ),
    ).rejects.toThrow("couldn't load");
    expect(landed).toBe(true);
  });

  test.serial("a refused code never lands", async () => {
    answer = () => Response.json({ error: "wrong code" }, { status: 401 });
    let landed = false;
    await expect(
      sendCode(
        { email: "maria@example.test", code: "123456" },
        () => {
          landed = true;
        },
        () => {},
      ),
    ).rejects.toThrow("wrong code");
    expect(landed).toBe(false);
  });

  test.serial("who is in: a user, nobody or no answer", async () => {
    answer = () =>
      Response.json({ user: null, emailOn: true, dictationOn: false });
    expect(await whoIs()).toBe("nobody");
    answer = () => Response.json({ user, emailOn: true, dictationOn: false });
    expect(await whoIs()).toBe("in");
    expect(me.value).toEqual(user);
    answer = () => new Response("", { status: 502 });
    expect(await whoIs()).toBe("failed");
  });
});

describe("SignIn", () => {
  afterEach(() => {
    emailOn.value = false;
  });

  test.serial("the email step: the field and the ways' menu", () => {
    emailOn.value = true;
    const html = render(<SignIn />);
    expect(withClass(html, "signin")).toBe(1);
    expect(withClass(html, "card", "signin-card")).toBe(1);
    expect(html).toContain('name="email"');
    expect(html).toContain('autocomplete="email"');
    expect(withClass(html, "signin-say", "error")).toBe(1);
    expect(withClass(html, "splitbutton-go", "splitbutton-go-split")).toBe(1);
    expect(html).toContain('aria-label="Ways to sign in"');
    expect(html).toContain(">Sign in</button>");
  });

  test.serial("the code step: six boxes, the line and the More menu", () => {
    emailOn.value = true;
    const html = render(<SignIn opening="code" address="maria@example.test" />);
    expect(withClass(html, "signin-box")).toBe(6);
    expect(html).toContain('autocomplete="one-time-code"');
    expect(html).toContain(">Code</span>");
    expect(html).toContain("Sent to maria@example.test");
    expect(withClass(html, "signin-say-cell", "signin-say-hold")).toBe(1);
    expect(html).toContain('aria-label="More"');
  });

  test.serial("the admin key step, alone while email is off", () => {
    const html = render(<SignIn />);
    expect(html).toContain('name="key"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain(">Admin key</span>");
    // one way alone: the button, no arrow
    expect(withClass(html, "splitbutton-pick")).toBe(0);
    expect(withClass(html, "splitbutton-go-split")).toBe(0);
  });
});

describe("SplitButton", () => {
  test("the arrow is a spinner while it works", () => {
    const items = [{ label: "Admin key", run: () => {} }];
    const idle = render(
      <SplitButton disabled={false} items={items} label="Ways">
        Sign in
      </SplitButton>,
    );
    expect(withClass(idle, "splitbutton-pick")).toBe(1);
    expect(withClass(idle, "splitbutton-spin")).toBe(0);
    const working = render(
      <SplitButton disabled items={items} label="Ways" working>
        Sending
      </SplitButton>,
    );
    expect(withClass(working, "splitbutton-spin")).toBe(1);
  });
});
