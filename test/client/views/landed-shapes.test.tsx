// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pages whose body is no card of rows wait in the shape they land
// in: an automation's summary, actions, tabs and tab card; the profile's
// sections; a project's Feed tab its composer over the feed; a user's
// head its lines; Connect agents' keys and setup and its new key form; a new
// file's band and box; a project's Settings sections. The editor's
// Memory and Needs attention wait as a switch over its box, and the
// Directory's search keeps what is typed while the list loads.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path, query } from "../../../src/client/app/router.ts";
import {
  accessKeys,
  accessKeysError,
} from "../../../src/client/data/access-keys.ts";
import {
  automationError,
  automationProject,
  automations,
} from "../../../src/client/data/automations.ts";
import {
  directoryAgents,
  directoryDeciders,
  directoryUsers,
  directoryUsersError,
  userPage,
} from "../../../src/client/data/directory.ts";
import { list } from "../../../src/client/data/feed.ts";
import { emailOn, me } from "../../../src/client/data/me.ts";
import { profile, profileError } from "../../../src/client/data/profile.ts";
import {
  project,
  projectError,
  projects,
} from "../../../src/client/data/projects.ts";
import { Connect } from "../../../src/client/views/connect/Connect.tsx";
import { Directory } from "../../../src/client/views/directory/Directory.tsx";
import { User } from "../../../src/client/views/directory/User.tsx";
import { NewDoc } from "../../../src/client/views/knowledge/file/DocPage.tsx";
import { EMAIL_HINT } from "../../../src/client/views/profile/Profile.model.ts";
import { Profile } from "../../../src/client/views/profile/Profile.tsx";
import { Automation } from "../../../src/client/views/projects/Automation.tsx";
import { EditAutomation } from "../../../src/client/views/projects/AutomationEditor.tsx";
import { EditorWaiting } from "../../../src/client/views/projects/EditorWaiting.tsx";
import { Project } from "../../../src/client/views/projects/Project.tsx";
import { Settings } from "../../../src/client/views/projects/Settings.tsx";
import { withClass } from "../../helpers/classes.ts";
import { mount } from "../../helpers/mount.ts";

const count = (html: string, part: string) => html.split(part).length - 1;

// the generic card of three rows Page draws when a page names no shape
const GENERIC = "card rows-card rows-waiting";

beforeEach(() => {
  me.value = {
    id: "u1",
    username: "casey",
    fullName: "Casey Doe",
    role: "admin",
  };
});

afterEach(() => {
  path.value = "/";
  query.value = "";
  project.value = null;
  projects.value = null;
  projectError.value = null;
});

describe("an automation waits as its summary and tabs", () => {
  beforeEach(() => {
    automations.value = null;
    automationProject.value = null;
    automationError.value = null;
  });

  test.serial("Runs: the summary, the actions, the filters' card", () => {
    path.value = "/automations/a1";
    query.value = "?runs=manual";
    const html = render(<Automation params={{ id: "a1" }} />);
    expect(html).toContain('aria-label="Loading the automation"');
    expect(html).not.toContain(GENERIC);
    expect(html).toContain("automations-summary");
    expect(html).toContain("automations-actions");
    for (const label of ["Next runs", "History", "Setup"]) {
      expect(html).toContain(`>${label}<`);
    }
    // the asked filter is on before the runs land
    expect(html).toMatch(/seg-on[^>]*>Manual</);
    // the runs' rows wait quiet: the summary is the page's one status
    expect(html).toContain("rows-waiting");
    expect(count(html, 'role="status"')).toBe(1);
    expect(html).not.toContain(">Memory<");
    // the name is a bone, never a stand-in word
    expect(html).not.toContain(">Automation<");
  });

  test.serial("Memory: its tab is on and the note's card waits", () => {
    path.value = "/automations/a1/memory";
    const html = render(<Automation params={{ id: "a1" }} />);
    expect(html).toContain(">Memory<");
    expect(html).toContain("note-empty");
    expect(html).not.toContain("rows-waiting");
    expect(count(html, 'role="status"')).toBe(1);
  });
});

describe("the editor's guided sections", () => {
  test("wait as a switch over a box of the landed rows", () => {
    const html = render(<EditorWaiting aside={null} />);
    // Memory's guidance is four rows, Needs attention's three
    expect(html).toContain("--rows:4");
    expect(html).toContain("--rows:3");
    expect(count(html, "automations-guidance")).toBe(2);
    // the instructions' box with its agent's chip under the text
    expect(html).toContain("automations-instructions-bar");
  });

  test("a row in hand draws the switch alone where it keeps none", () => {
    const html = render(
      <EditorWaiting
        aside={null}
        row={{ ownMemory: false, attentionMode: "off" }}
      />,
    );
    expect(html).not.toContain("--rows:4");
    expect(html).not.toContain("--rows:3");
    expect(count(html, "automations-guidance")).toBe(0);
  });

  test.serial("the edit page's crumb is a bone until the name lands", () => {
    automations.value = null;
    automationProject.value = null;
    automationError.value = null;
    const html = render(<EditAutomation params={{ id: "a1" }} />);
    expect(html).toContain("page-crumb-bone");
    expect(html).not.toContain(">Automation<");
  });
});

describe("a project's Feed tab waits as its composer over the feed", () => {
  afterEach(() => {
    list.value = null;
  });

  test.serial("the composer's bone, the feed's head and its rows", () => {
    path.value = "/projects/p1";
    const html = render(<Project params={{ id: "p1" }} />);
    expect(html).toContain("home-composer");
    expect(html).toContain('placeholder="Search sessions"');
    expect(html).toContain("feed-ghosts");
    expect(html).not.toContain(GENERIC);
    // the composer waits quiet: the rows say the page loads
    expect(count(html, 'role="status"')).toBe(1);
  });
});

describe("a user's page waits with the head's lines", () => {
  afterEach(() => {
    userPage.value = null;
  });

  test.serial("the email and the local time a phone shows", () => {
    userPage.value = null;
    path.value = "/users/ada";
    const html = render(<User params={{ username: "ada" }} />);
    expect(html).toContain('aria-label="Loading the user"');
    expect(count(html, "who-line who-narrow")).toBe(2);
  });
});

describe("the profile waits as its sections", () => {
  beforeEach(() => {
    profile.value = null;
    profileError.value = null;
  });
  afterEach(() => {
    emailOn.value = false;
  });

  test.serial("who it is and About you, Save in bones", () => {
    emailOn.value = false;
    const html = render(<Profile />);
    expect(html).toContain('aria-label="Loading your profile"');
    expect(html).toContain("who-waiting-avatar");
    expect(html).toContain(">About you<");
    expect(html).not.toContain(">Password<");
    expect(html).not.toContain(">Email<");
    expect(withClass(html, "foot")).toBe(1);
    expect(html).not.toContain(GENERIC);
  });

  test.serial("the Email section while email is set up", () => {
    emailOn.value = true;
    const html = render(<Profile />);
    expect(html).toContain(">Email<");
    expect(html).toContain(EMAIL_HINT);
    expect(withClass(html, "foot")).toBe(2);
  });
});

describe("Connect agents waits as its keys and setup", () => {
  beforeEach(() => {
    accessKeys.value = null;
    accessKeysError.value = null;
  });

  for (const [at, tab] of [
    ["/connect", "Claude Code"],
    ["/connect/codex", "Codex"],
    ["/connect/opencode", "OpenCode"],
  ] as const) {
    test.serial(`${at}: a key's row, the lead and the setup`, () => {
      path.value = at;
      const html = render(<Connect />);
      expect(html).toContain('aria-label="Loading access keys"');
      expect(html).toContain("connect-lead");
      // the setup needs no answer, so its tab is drawn in words
      expect(html).toMatch(new RegExp(`tabs-tab-on[^>]*>${tab}<`));
      expect(html).toContain("connect-snippet");
    });
  }

  test.serial("the new key form: one card of its four fields", () => {
    query.value = "?new";
    const html = render(<Connect />);
    expect(html).toContain('aria-label="Loading the new key form"');
    expect(count(html, "bones-bone-field")).toBe(1);
    expect(count(html, "bones-bone-seg")).toBe(3);
    // Expires after lands with no hint under it
    expect(withClass(html, "hint")).toBe(3);
  });
});

describe("a new file and the Settings tab wait in their shape", () => {
  test.serial("a new file: the head's buttons, the path, the text box", () => {
    const html = render(<NewDoc params={{ id: "p1" }} />);
    expect(html).toContain('aria-label="Loading the new file"');
    expect(html).toContain(">Cancel<");
    expect(html).toContain(">Path<");
    expect(html).toContain("docpage-editor-waiting");
    expect(html).toContain("page-crumb-bone");
    expect(html).not.toContain(GENERIC);
  });

  test.serial("Settings: each section under its own words", () => {
    path.value = "/projects/p1/settings";
    const html = render(<Settings params={{ id: "p1" }} />);
    expect(html).toContain('aria-label="Loading the settings"');
    for (const title of [
      "About this project",
      "Labels",
      "Repositories",
      "MCP Servers",
    ]) {
      expect(html).toContain(`>${title}<`);
    }
    expect(html).not.toContain(GENERIC);
  });
});

describe("the Directory's search while its list loads", () => {
  beforeEach(() => {
    directoryUsers.value = null;
    directoryUsersError.value = null;
    directoryAgents.value = null;
    directoryDeciders.value = null;
    path.value = "/directory";
  });

  test.serial("keeps what is typed into the landed card", async () => {
    const view = await mount(<Directory />);
    expect(view.html()).toContain('aria-label="Loading users"');
    await view.type("search-input", "ada");
    directoryUsers.value = [
      {
        id: "u1",
        username: "casey",
        fullName: "Casey Doe",
        role: "member",
        tz: "UTC",
      },
      {
        id: "u2",
        username: "ada",
        fullName: "Ada Min",
        role: "admin",
        tz: "UTC",
      },
    ];
    await view.update(<Directory />);
    const html = view.html();
    expect(html).not.toContain('aria-label="Loading users"');
    expect(html).toContain(">1 of 2<");
    expect(html).toContain("Ada Min");
    expect(html).not.toContain("Casey Doe");
    await view.unmount();
  });
});
