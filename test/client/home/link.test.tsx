// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sign-in page's email links and the page an email links to: the
// words for each link, the account already signed in, and the data that
// reads the link and acts on it.

import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  applyLink,
  askLink,
  link,
  linkError,
  loadLink,
} from "../../../src/client/data/links.ts";
import { emailOn, me } from "../../../src/client/data/me.ts";
import {
  GONE_LINE,
  linkWords,
  newPasswordProblem,
  otherAccount,
} from "../../../src/client/views/home/Link.model.ts";
import { Link } from "../../../src/client/views/home/Link.tsx";
import {
  askedLine,
  askProblem,
} from "../../../src/client/views/home/Login.model.ts";
import { Login } from "../../../src/client/views/home/Login.tsx";
import { clientFetch } from "../../helpers/client-fetch.ts";

const TOKEN = "t".repeat(43);
const maria = {
  id: "u2",
  username: "maria",
  fullName: "Maria Pop",
  role: "member" as const,
  mustChangePassword: false,
};

let answer: (url: string, init?: RequestInit) => Response;
const calls = clientFetch((url, init) => answer(url, init));

beforeEach(() => {
  me.value = null;
  emailOn.value = false;
  link.value = null;
  linkError.value = null;
});

describe("the words", () => {
  test.serial("say what each link does and for whom", () => {
    expect(linkWords("reset", "maria")).toMatchObject({
      title: "Choose a new password",
      button: "Set password",
      password: true,
    });
    expect(linkWords("invite", "maria")).toMatchObject({
      line: "Choose a password for @maria.",
      password: true,
    });
    expect(linkWords("signin", "maria")).toMatchObject({
      title: "Sign in as @maria",
      button: "Sign in",
      password: false,
    });
    for (const purpose of ["reset", "invite", "signin"] as const) {
      expect(JSON.stringify(linkWords(purpose, "maria"))).not.toMatch(/[—;]/);
    }
  });

  test.serial("name the account signed in only when it is another", () => {
    expect(otherAccount(null, "maria")).toBeNull();
    expect(otherAccount("maria", "maria")).toBeNull();
    expect(otherAccount("admin", "maria")).toBe(
      "You are signed in as @admin. Going on signs you in as @maria instead.",
    );
  });

  test.serial("check the new password", () => {
    expect(newPasswordProblem("short")).toBe(
      "The password needs at least 8 characters",
    );
    expect(newPasswordProblem("longenough")).toBeNull();
  });

  test.serial("an ask needs a name and answers the same for any", () => {
    expect(askProblem("  ")).toBe("Enter your username or email first.");
    expect(askProblem("maria")).toBeNull();
    expect(askedLine("forgot")).toContain("reset link");
    expect(askedLine("link")).toContain("sign in link");
  });
});

describe("the sign-in page", () => {
  test.serial("offers the email links only with email on", () => {
    const off = render(<Login />);
    expect(off).toContain(">Username<");
    expect(off).not.toContain("Forgot password?");
    expect(off).not.toContain("Email me a sign in link");
    emailOn.value = true;
    const on = render(<Login />);
    expect(on).toContain(">Username or email<");
    expect(on).toContain("Forgot password?");
    expect(on).toContain("Email me a sign in link");
  });
});

describe("the link page", () => {
  test.serial("names the account and asks a password for a reset", () => {
    link.value = {
      token: TOKEN,
      value: { purpose: "reset", username: "maria" },
    };
    const html = render(<Link params={{ token: TOKEN }} />);
    expect(html).toContain("Choose a new password");
    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain("Set password");
    expect(html).not.toContain("You are signed in");
  });

  test.serial(
    "says who is signed in before a sign in link replaces them",
    () => {
      me.value = { ...maria, id: "u1", username: "admin" };
      link.value = {
        token: TOKEN,
        value: { purpose: "signin", username: "maria" },
      };
      const html = render(<Link params={{ token: TOKEN }} />);
      expect(html).toContain("Sign in as @maria");
      expect(html).toContain("You are signed in as @admin.");
      expect(html).not.toContain('type="password"');
    },
  );

  test.serial("a dead link says so and leads to sign in", () => {
    link.value = { token: TOKEN, value: null };
    const html = render(<Link params={{ token: TOKEN }} />);
    expect(html).toContain(GONE_LINE);
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("<form");
  });

  test.serial("a failed read shows the server's words", () => {
    linkError.value = { words: "the server is busy", status: 503 };
    const html = render(<Link params={{ token: TOKEN }} />);
    expect(html).toContain("The server is busy.");
    expect(html).toContain('href="/login"');
  });
});

describe("the data", () => {
  test.serial(
    "reads the link, acts once and signs in as its user",
    async () => {
      answer = (_url, init) =>
        init?.method === "POST"
          ? Response.json({ user: maria })
          : Response.json({
              link: { purpose: "signin", username: "maria" },
            });
      await loadLink(TOKEN);
      expect(link.value).toEqual({
        token: TOKEN,
        value: { purpose: "signin", username: "maria" },
      });
      await applyLink(TOKEN, {});
      expect(me.value).toEqual(maria);
      expect(link.value).toBeNull();
      expect(calls.at(-1)?.url).toBe(`/api/links/${TOKEN}`);
      expect(calls.at(-1)?.init?.method).toBe("POST");
    },
  );

  test.serial("a dead link reads as null, not an error", async () => {
    answer = () => Response.json({ link: null });
    await loadLink(TOKEN);
    expect(link.value).toEqual({ token: TOKEN, value: null });
    expect(linkError.value).toBeNull();
  });

  test.serial("a failed read is the link's error", async () => {
    answer = () =>
      Response.json({ error: "the server is busy" }, { status: 503 });
    await loadLink(TOKEN);
    expect(link.value).toBeNull();
    expect(linkError.value).toEqual({
      words: "the server is busy",
      status: 503,
    });
  });

  test.serial("asks for a link by name", async () => {
    answer = () => new Response(null, { status: 202 });
    await askLink("forgot", "maria");
    expect(calls.at(-1)?.url).toBe("/api/login/forgot");
    expect(calls.at(-1)?.init?.body).toBe('{"username":"maria"}');
  });
});
