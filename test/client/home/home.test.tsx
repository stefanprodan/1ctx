// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { me } from "../../../src/client/data/me.ts";
import {
  dateLine,
  greeting,
} from "../../../src/client/views/home/Home.model.ts";
import { Home } from "../../../src/client/views/home/Home.tsx";
import { Login } from "../../../src/client/views/home/Login.tsx";

describe("Home.model", () => {
  test("greets by the hour", () => {
    const at = (h: number) => new Date(2026, 8, 12, h);
    expect(greeting(at(3), "Oana")).toBe("Good night, Oana");
    expect(greeting(at(9), "Oana")).toBe("Good morning, Oana");
    expect(greeting(at(14), "Oana")).toBe("Good afternoon, Oana");
    expect(greeting(at(21), "Oana")).toBe("Good evening, Oana");
  });

  test("the date line is weekday, day and month", () => {
    expect(dateLine(new Date(2026, 8, 12))).toBe("Saturday 12 September");
  });
});

describe("Home", () => {
  test("renders the head with the classes home.css and page.css depend on", () => {
    me.value = { id: "u1", username: "oana", fullName: "Oana", role: "member" };
    const html = render(<Home />);
    expect(html).toContain('class="page-title"');
    expect(html).toContain(", Oana</h1>");
    expect(html).toContain('class="home-stream"');
  });
});

describe("Login", () => {
  test("renders the form with the classes login.css depends on", () => {
    const html = render(<Login />);
    expect(html).toContain('class="login"');
    expect(html).toContain('class="login-form card"');
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('type="password"');
    expect(html).toContain("Sign in");
  });
});
