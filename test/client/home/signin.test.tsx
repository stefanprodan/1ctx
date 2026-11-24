// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { App } from "../../../src/client/app/App.tsx";
import { path } from "../../../src/client/app/router.ts";
import {
  handedOver,
  holdHandOver,
  takeHandOver,
} from "../../../src/client/data/links.ts";
import { emailOn, me, meError } from "../../../src/client/data/me.ts";
import { signInWords } from "../../../src/client/data/sign-in.ts";
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
import { deferred, settle } from "../../helpers/async.ts";
import { withClass } from "../../helpers/classes.ts";
import { clientFetch } from "../../helpers/client-fetch.ts";
import { type Mounted, mount } from "../../helpers/mount.ts";

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
  test("takes a real address from the fragment, or nothing", () => {
    expect(handedOver("#code=maria%40example.test")).toBe("maria@example.test");
    expect(handedOver("#code=nobody")).toBeNull();
    expect(handedOver("#code=a%40b")).toBeNull();
    expect(handedOver("#code=%E0%A4%A")).toBeNull();
    expect(handedOver("#section")).toBeNull();
    expect(handedOver("")).toBeNull();
  });

  test.serial("strips the reserved fragment, valid or not", () => {
    let strips = 0;
    const strip = () => {
      strips++;
    };
    holdHandOver("#code=not-an-address", strip);
    expect(strips).toBe(1);
    expect(takeHandOver()).toBeNull();
    holdHandOver("#section", strip);
    expect(strips).toBe(1);
    holdHandOver("#code=maria%40example.test", strip);
    expect(strips).toBe(2);
    expect(takeHandOver()).toBe("maria@example.test");
    expect(takeHandOver()).toBeNull();
  });

  test.serial("a browser signed in already drops it", () => {
    holdHandOver("#code=maria%40example.test", () => {});
    me.value = user;
    expect(takeHandOver()).toBeNull();
    me.value = undefined;
  });
});

describe("the sign-in's words", () => {
  test("say the status, never the body", () => {
    const wrong = "wrong or expired code";
    expect(signInWords(0, wrong)).toBe("the server did not answer");
    expect(signInWords(401, wrong)).toBe(wrong);
    expect(signInWords(400, wrong)).toBe("email is an email address");
    expect(signInWords(403, wrong)).toBe("not sent from this server's pages");
    expect(signInWords(404, wrong)).toBe("email is off");
    expect(signInWords(429, wrong)).toBe("too many tries; wait a minute");
    expect(signInWords(500, wrong)).toBe("the server failed");
    expect(signInWords(502, wrong)).toBe("the server failed");
    expect(signInWords(413, wrong)).toBe("refused");
  });
});

const user: Me = {
  id: "u1",
  username: "maria",
  fullName: "Maria",
  role: "member",
};

describe("signing in on the card", () => {
  // the server, by method and path: each call takes the next answer queued
  // for it, and a call nothing was queued for fails the test
  type Answer = () => Response | Promise<Response>;
  const answers = new Map<string, Answer[]>();
  const queue = (route: string, ...list: Answer[]) => {
    answers.set(route, [...(answers.get(route) ?? []), ...list]);
  };
  const calls = clientFetch((url, init) => {
    const route = `${init?.method ?? "GET"} ${url}`;
    const next = answers.get(route)?.shift();
    if (next === undefined) throw new Error(`unexpected ${route}`);
    return next();
  });
  const json =
    (body: unknown, status = 200) =>
    () =>
      Response.json(body, { status });
  const routes = () => calls.map((c) => `${c.init?.method ?? "GET"} ${c.url}`);

  const g = globalThis as Record<string, unknown>;
  const held = {
    location: g.location,
    history: g.history,
    localStorage: g.localStorage,
  };
  let mounted: Mounted | null = null;
  let kept: Map<string, string>;

  beforeEach(() => {
    answers.clear();
    kept = new Map();
    g.location = { origin: "http://1ctx.test", pathname: "/", search: "" };
    g.history = { pushState() {}, replaceState() {} };
    g.localStorage = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => kept.set(k, v),
    };
    emailOn.value = true;
    me.value = null;
  });
  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    Object.assign(g, held);
    emailOn.value = false;
    me.value = undefined;
    meError.value = null;
  });

  const codeStep = async () => {
    mounted = await mount(
      <SignIn opening="code" address="maria@example.test" />,
    );
    return mounted;
  };
  // the system's one-time code fills every box at once
  const fill = (m: Mounted, code: string) =>
    m.fire("signin-box", "onInput", { value: code });

  test.serial("a refused code says so, whatever the body says", async () => {
    queue("POST /api/login/code", json({ error: "anything at all" }, 401));
    const m = await codeStep();
    await fill(m, "123456");
    await settle();
    expect(m.html()).toContain("Wrong or expired code.");
    expect(withClass(m.html(), "signin-box", "signin-box-wrong")).toBe(6);
    expect(me.value).toBeNull();
  });

  test.serial(
    "a failed read after a taken code offers Try again, never a repost",
    async () => {
      queue("POST /api/login/code", json({ user, landing: "/" }));
      queue(
        "GET /api/me",
        () => new Response("<html>proxy</html>", { status: 502 }),
        // a malformed answer is no answer: still Try again
        json({ user: { id: "u1" }, emailOn: true }),
        json({ user, emailOn: true, dictationOn: false }),
      );
      const m = await codeStep();
      await fill(m, "123456");
      await settle();
      expect(m.html()).toContain("Couldn't load.");
      expect(m.html()).toContain(">Try again</button>");
      expect(me.value).toBeNull();
      await m.fire("splitbutton-go", "onClick");
      await settle();
      expect(m.html()).toContain(">Try again</button>");
      expect(me.value).toBeNull();
      await m.fire("splitbutton-go", "onClick");
      await settle();
      expect(me.value).toEqual(user);
      expect(routes()).toEqual([
        "POST /api/login/code",
        "GET /api/me",
        "GET /api/me",
        "GET /api/me",
      ]);
    },
  );

  test.serial("an ask refused says the sign-in's words", async () => {
    queue("POST /api/login/link", json({ error: "slow down" }, 429));
    mounted = await mount(<SignIn />);
    const m = mounted;
    await m.fire("signin-input", "onInput", { value: "maria@example.test" });
    await m.fire("signin-form", "onSubmit");
    await settle();
    expect(m.html()).toContain("Too many tries; wait a minute.");
    expect(m.html()).toContain('name="email"');
  });

  test.serial("an ask sent moves on to the code", async () => {
    queue("POST /api/login/link", () => new Response(null, { status: 202 }));
    mounted = await mount(<SignIn />);
    const m = mounted;
    await m.fire("signin-input", "onInput", { value: "maria@example.test" });
    await m.fire("signin-form", "onSubmit");
    await settle();
    expect(withClass(m.html(), "signin-box")).toBe(6);
    expect(m.html()).toContain("Sent to maria@example.test");
  });

  test.serial(
    "a way picked in the menu swaps the field and is kept",
    async () => {
      mounted = await mount(<SignIn />);
      const m = mounted;
      expect(m.html()).toContain('name="email"');
      await m.fire("splitbutton-pick", "onClick");
      expect(withClass(m.html(), "menu-item")).toBe(2);
      await m.fire("menu-item", "onClick", {}, 1);
      expect(m.html()).toContain('name="key"');
      expect(m.html()).not.toContain('name="email"');
      expect(kept.get(KEPT_WAY)).toBe("key");
    },
  );
  test.serial(
    "a taken code with an unreadable answer is spent all the same",
    async () => {
      queue("POST /api/login/code", () => new Response("not json"));
      queue(
        "GET /api/me",
        () => new Response("<html>proxy</html>", { status: 502 }),
        json({ user, emailOn: true, dictationOn: false }),
      );
      const m = await codeStep();
      await fill(m, "123456");
      await settle();
      expect(m.html()).toContain(">Try again</button>");
      await m.fire("splitbutton-go", "onClick");
      await settle();
      expect(me.value).toEqual(user);
      // the retry only reads: the spent code is never posted again
      expect(routes()).toEqual([
        "POST /api/login/code",
        "GET /api/me",
        "GET /api/me",
      ]);
    },
  );

  test.serial("a post from another site's page says so", async () => {
    queue("POST /api/login/link", json({ error: "cross-site" }, 403));
    mounted = await mount(<SignIn />);
    const m = mounted;
    await m.fire("signin-input", "onInput", { value: "maria@example.test" });
    await m.fire("signin-form", "onSubmit");
    await settle();
    expect(m.html()).toContain("Not sent from this server's pages.");
  });

  test.serial(
    "a failed read after a key keeps the card while the first load is out",
    async () => {
      emailOn.value = false;
      me.value = undefined;
      const first = deferred<Response>();
      queue(
        "GET /api/me",
        () => first.promise,
        () => new Response("<html>proxy</html>", { status: 502 }),
      );
      queue("POST /api/login", json({ user }));
      const was = path.value;
      path.value = "/login";
      try {
        mounted = await mount(<App />);
        const m = mounted;
        await m.fire("signin-input", "onInput", { value: "1ctx-admin-key" });
        await m.fire("signin-form", "onSubmit");
        await settle();
        expect(withClass(m.html(), "signin-card")).toBe(1);
        expect(m.html()).toContain("The server failed.");
        expect(withClass(m.html(), "shell-fail")).toBe(0);
        // the first load, superseded, lands nothing
        first.resolve(
          Response.json({ user: null, emailOn: false, dictationOn: false }),
        );
        await settle();
        expect(withClass(m.html(), "signin-card")).toBe(1);
        expect(me.value).toBeUndefined();
      } finally {
        path.value = was;
      }
    },
  );
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
