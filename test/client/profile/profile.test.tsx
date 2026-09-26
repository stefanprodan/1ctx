// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { favourite } from "../../../src/client/data/favourite.ts";
import { profile } from "../../../src/client/data/profile.ts";
import { initials, longDate } from "../../../src/client/lib/format.ts";
import {
  aboutProblem,
  fullNameProblem,
  passwordProblem,
} from "../../../src/client/views/profile/Profile.model.ts";
import { Profile } from "../../../src/client/views/profile/Profile.tsx";

describe("initials", () => {
  test("first letters of the first two words, else two letters", () => {
    expect(initials("Stefan Prodan")).toBe("SP");
    expect(initials("Casey Maria Doe")).toBe("CM");
    expect(initials("admin")).toBe("AD");
    expect(initials("  x ")).toBe("X");
    expect(initials("")).toBe("");
  });
});

describe("longDate", () => {
  test("day, month and year", () => {
    expect(longDate(new Date(2026, 8, 12).getTime())).toBe("12 September 2026");
  });
});

describe("Profile.model", () => {
  test("the full name rule", () => {
    expect(fullNameProblem("Casey")).toBeNull();
    expect(fullNameProblem(" Casey ")).toBeNull();
    expect(fullNameProblem("")).toBe("Enter a name");
    expect(fullNameProblem("a".repeat(65))).toContain("under 64");
    expect(fullNameProblem("a\nb")).toBe("One line only");
    expect(fullNameProblem("a\u2028b")).toBe("One line only");
  });

  test("the about rule", () => {
    expect(aboutProblem("")).toBeNull();
    expect(aboutProblem("a".repeat(2001))).toContain("under 2000");
  });

  test("the password rule", () => {
    expect(passwordProblem("old", "longenough", "longenough")).toBeNull();
    expect(passwordProblem("", "longenough", "longenough")).toContain(
      "current",
    );
    expect(passwordProblem("old", "short", "short")).toContain("at least 8");
    expect(passwordProblem("longenough", "longenough", "longenough")).toContain(
      "same",
    );
    expect(passwordProblem("old", "longenough", "other")).toContain("differ");
  });
});

describe("Profile", () => {
  test("renders the head and the two sections with the classes profile.css depends on", () => {
    profile.value = {
      id: "u1",
      username: "casey",
      fullName: "Casey Doe",
      email: "casey@example.com",
      tz: "Europe/Bucharest",
      disabled: false,
      mustChangePassword: false,
      about: "Actor.",
      role: "member",
      createdAt: new Date(2026, 8, 12).getTime(),
    };
    const html = render(<Profile />);
    expect(html).toContain('class="profile"');
    expect(html).toContain('class="avatar avatar-56">CD<');
    expect(html).toContain("@casey");
    expect(html).toContain('class="section"');
    expect(html).toContain('class="split-aside"');
    expect(html).toContain(">Account<");
    expect(html).toContain(">casey@example.com<");
    expect(html).toContain(">Member<");
    expect(html).toContain("12 September 2026");
    expect(html).toContain('autocomplete="name"');
    expect(html).toContain('name="about"');
    expect(html).toContain(">Actor.</textarea>");
    expect(html).toContain("Europe/Bucharest");
    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain("Change password");
  });

  test.serial("picks the favourite agent, the default first", () => {
    profile.value = {
      id: "u1",
      username: "casey",
      fullName: "Casey Doe",
      email: "casey@example.com",
      tz: "UTC",
      disabled: false,
      mustChangePassword: false,
      about: "",
      role: "member",
      createdAt: 0,
    };
    favourite.value = null;
    expect(render(<Profile />)).not.toContain("Favourite agent");
    const agents = [
      { id: "a1", name: "coder", avatar: "bot" as const },
      { id: "a2", name: "writer", avatar: "bot" as const },
    ];
    favourite.value = { agentId: null, defaultId: "a1", agents };
    let html = render(<Profile />);
    expect(html).toContain("The agent new chats and tasks start on.");
    expect(html).toContain(">Favourite agent<");
    expect(html).toContain("The default");
    favourite.value = { agentId: "a2", defaultId: "a1", agents };
    html = render(<Profile />);
    expect(html).toContain("@writer");
    // with no agents there is nothing to pick
    favourite.value = { agentId: null, defaultId: null, agents: [] };
    expect(render(<Profile />)).not.toContain("Favourite agent");
    favourite.value = null;
  });

  test("tells a person with a handed password to change it", () => {
    profile.value = {
      id: "u1",
      username: "casey",
      fullName: "Casey Doe",
      email: "casey@example.com",
      tz: "Europe/Bucharest",
      disabled: false,
      mustChangePassword: true,
      about: "",
      role: "member",
      createdAt: 0,
    };
    const html = render(<Profile />);
    expect(html).toContain("profile-notice");
    expect(html).toContain("before going on");
    profile.value = { ...profile.value, mustChangePassword: false };
    expect(render(<Profile />)).not.toContain("profile-notice");
  });

  test("shows the loading line before the row arrives", () => {
    profile.value = null;
    expect(render(<Profile />)).toContain("Loading");
  });
});
