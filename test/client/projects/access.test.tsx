// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The task editor's Access section, one list with the project's
// credentials after Web access, and the Setup aside naming those off.

import { afterEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { answered } from "../../../src/client/data/capabilities.ts";
import { AccessSection } from "../../../src/client/views/projects/AccessSection.tsx";
import { AccessLines } from "../../../src/client/views/projects/AutomationAccess.tsx";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";

const credentials = [
  { id: "c1", name: "finnhub" },
  { id: "c2", name: "github" },
];

const section = (
  web: { live: boolean; on: boolean; reason: string | null },
  knowledgeOn = true,
) =>
  render(
    <AccessSection
      web={web}
      webOn={web.on}
      onWeb={() => {}}
      visuals={{ live: true, on: true, reason: null }}
      visualsOn
      onVisuals={() => {}}
      knowledge={{ live: true, on: true, reason: null }}
      knowledgeOn={knowledgeOn}
      onKnowledge={() => {}}
      servers={[]}
      mcpOff={[]}
      onServer={() => {}}
      skills={[]}
      skillsOff={[]}
      onSkill={() => {}}
      credentials={credentials}
      credentialsOff={["credential:c2"]}
      onCredential={() => {}}
      disabled={false}
    />,
  );

// the switches of the credentials, in order: whether each is on
const credentialSwitches = (html: string) =>
  [...html.matchAll(/aria-label="(finnhub|github) (on|off)"/g)].map(
    (m) => `${m[1]} ${m[2]}`,
  );

describe("the Access section's credentials", () => {
  test("a switch per credential after web access, off as the draft says", () => {
    const html = section({ live: true, on: true, reason: null });
    expect(credentialSwitches(html)).toEqual(["finnhub on", "github off"]);
    expect(html.indexOf("Web access")).toBeLessThan(html.indexOf("finnhub"));
    expect(html.indexOf("github")).toBeLessThan(html.indexOf("Visuals"));
    expect(html.match(/>credential</g)?.length).toBe(2);
    expect(html).not.toContain("rows-item-off");
  });

  test("with the web off, every one is off and faint, saying why", () => {
    const html = section({ live: true, on: false, reason: null });
    expect(credentialSwitches(html)).toEqual(["finnhub off", "github off"]);
    expect(html.match(/needs web access/g)?.length).toBe(2);
    expect(html.match(/rows-item-off/g)?.length).toBe(2);
  });

  test("when the web cannot be switched, its row says why once", () => {
    const html = section({
      live: false,
      on: false,
      reason: "Turned off by an admin",
    });
    expect(credentialSwitches(html)).toEqual(["finnhub off", "github off"]);
    expect(html.match(/Turned off by an admin/g)?.length).toBe(1);
    expect(html.match(/rows-item-off/g)?.length).toBe(3);
  });
});

describe("the Access section's Knowledge switch", () => {
  test("is a row after Visuals, on and off as the draft says", () => {
    const web = { live: true, on: true, reason: null };
    const on = section(web);
    expect(on).toContain("project docs");
    expect(on).toContain('aria-label="Knowledge on"');
    expect(on.indexOf("Visuals")).toBeLessThan(on.indexOf("Knowledge"));
    expect(section(web, false)).toContain('aria-label="Knowledge off"');
  });
});

describe("the Setup aside", () => {
  afterEach(() => {
    answered({
      agents: [],
      startsOn: null,
      capabilities: [],
      servers: {},
      skills: {},
      credentials: [],
      repos: [],
    });
  });

  const row = (disabledCapabilities: string[]) =>
    ({ agentId: "a1", disabledCapabilities }) as unknown as AutomationSummary;

  test.serial("names the project's credentials that are off", () => {
    answered({
      agents: [],
      startsOn: null,
      capabilities: ["web"],
      servers: {},
      skills: {},
      credentials,
      repos: [],
    });
    const html = render(
      <AccessLines row={row(["credential:c2", "credential:gone"])} />,
    );
    expect(html).toContain("Credentials off");
    expect(html).toContain("github");
    expect(html).not.toContain("finnhub");
    expect(render(<AccessLines row={row([])} />)).toBe("");
  });

  test.serial("says Visuals and Knowledge Off by their keys", () => {
    answered({
      agents: [],
      startsOn: null,
      capabilities: ["visualize", "knowledge"],
      servers: {},
      skills: {},
      credentials: [],
      repos: [],
    });
    const html = render(<AccessLines row={row(["knowledge"])} />);
    expect(html).toContain("Knowledge");
    expect(html).toContain("Off");
    expect(html).not.toContain("Visuals");
    const both = render(<AccessLines row={row(["knowledge", "visualize"])} />);
    expect(both.indexOf("Visuals")).toBeLessThan(both.indexOf("Knowledge"));
  });

  test.serial("says Web access Off alone while the web is off", () => {
    answered({
      agents: [],
      startsOn: null,
      capabilities: ["web"],
      servers: {},
      skills: {},
      credentials,
      repos: [],
    });
    const html = render(<AccessLines row={row(["credential:c2", "web"])} />);
    expect(html).toContain("Web access");
    expect(html).not.toContain("Credentials off");
  });
});
