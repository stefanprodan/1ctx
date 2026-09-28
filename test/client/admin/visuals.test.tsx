// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  limits,
  tools,
  toolsError,
  visualsUsage,
} from "../../../src/client/data/tools.ts";
import { ToolRow } from "../../../src/client/views/admin/ToolRow.tsx";
import {
  hostsDirty,
  hostsText,
  isDefaultHosts,
  visualsLine,
} from "../../../src/client/views/admin/Visuals.model.ts";
import { Visuals } from "../../../src/client/views/admin/Visuals.tsx";
import type { ToolsResponse } from "../../../src/shared/api/tools.ts";
import type { LimitRow } from "../../../src/shared/contracts/limit.ts";
import {
  DEFAULT_VISUAL_HOSTS,
  type WebToolSummary,
} from "../../../src/shared/contracts/tool.ts";

const visual: WebToolSummary = {
  name: "visualize",
  description: "Draw a visual in the chat. It runs in a frame.",
  parameters: { type: "object", properties: {} },
  parametersHtml: '<pre class="md-pre">{}</pre>',
  tokens: 204,
  enabled: true,
  hosts: ["https://a.example.com", "https://b.example.com"],
  updatedAt: 0,
};

const response = (changes: Partial<WebToolSummary> = {}): ToolsResponse => ({
  builtin: [],
  access: { mode: "all", domains: [], updatedAt: 0 },
  visualize: { ...visual, ...changes },
  search: {
    provider: null,
    keys: { exa: false, firecrawl: false, tavily: false },
  },
});

const limit = (changes: Partial<LimitRow>): LimitRow => ({
  name: "maxVisuals",
  value: 2,
  default: 2,
  min: 1,
  max: 10,
  unit: "count",
  scope: "visuals",
  changedAt: null,
  ...changes,
});
const rows: LimitRow[] = [
  limit({
    name: "visualBytes",
    value: 128 * 1024,
    default: 256 * 1024,
    min: 16 * 1024,
    max: 1024 * 1024,
    unit: "bytes",
    changedAt: 5,
  }),
  limit({
    name: "visualSendBytes",
    value: 1024 * 1024,
    default: 1024 * 1024,
    min: 64 * 1024,
    max: 8 * 1024 * 1024,
    unit: "bytes",
  }),
  limit({}),
  limit({ name: "rounds", value: 100, default: 100, scope: "send" }),
];

describe("the Visuals words", () => {
  test("the line says what the saved switch does", () => {
    expect(visualsLine(true)).toBe(
      "Allows agents to draw HTML and SVG visuals.",
    );
    expect(visualsLine(false)).toBe("In-line visualizations are disabled.");
  });

  test("the box is dirty only when its origins differ", () => {
    expect(hostsText(["https://a.example.com"])).toBe("https://a.example.com");
    expect(hostsText()).toBe(DEFAULT_VISUAL_HOSTS.join("\n"));
    expect(
      hostsDirty("https://a.example.com\n", ["https://a.example.com"]),
    ).toBe(false);
    expect(hostsDirty("", ["https://a.example.com"])).toBe(true);
    expect(isDefaultHosts(hostsText())).toBe(true);
    expect(isDefaultHosts("https://a.example.com")).toBe(false);
    expect(isDefaultHosts("not an origin")).toBe(false);
  });
});

describe("the Visuals page", () => {
  let held: [
    typeof tools.value,
    typeof limits.value,
    typeof visualsUsage.value,
  ];
  beforeEach(() => {
    held = [tools.value, limits.value, visualsUsage.value];
  });
  afterEach(() => {
    [tools.value, limits.value, visualsUsage.value] = held;
    toolsError.value = null;
  });

  test.serial("three cards, each its own form, nothing to save at rest", () => {
    tools.value = response();
    limits.value = rows;
    visualsUsage.value = null;
    const html = render(<Visuals />);
    expect(html.match(/<form/g)).toHaveLength(3);
    expect(
      [...html.matchAll(/setting-title">([^<]+)</g)].map((m) => m[1]),
    ).toEqual(["Visuals", "CDNs", "Limits"]);
    // the switch sits in the first card's head, the tool as its row
    expect(html.match(/role="switch"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Visuals on"');
    expect(html).toContain(visualsLine(true));
    expect(html).toContain(">visualize<");
    expect(html).toMatch(/204 tokens/);
    // every Save waits for a change
    expect(html.match(/type="submit"[^>]*disabled/g)).toHaveLength(3);
    expect(html).not.toContain("Unsaved changes");
    // the CDNs: the count, the box as saved
    expect(html).toMatch(/setting-count">2 of 16</);
    expect(html).toMatch(
      /<textarea name="hosts"[^>]*>https:\/\/a\.example\.com\nhttps:\/\/b\.example\.com</,
    );
    // the visual limits alone, typed as text, a changed one's default
    expect(html).toContain('name="visualBytes"');
    expect(html).toContain('name="maxVisuals"');
    expect(html).not.toContain('name="rounds"');
    expect(html).toContain('value="128"');
    expect(html).toContain("default 256 KB");
    expect(html).not.toContain('type="number"');
    expect(html).toContain('inputmode="decimal"');
    // the aside waits for its read
    expect(html).toContain("Last 30 days");
    expect(html).toContain("Loading");
  });

  test.serial("Use defaults waits while a card holds the defaults", () => {
    tools.value = response({ hosts: [...DEFAULT_VISUAL_HOSTS] });
    limits.value = rows.map((r) => ({
      ...r,
      value: r.default,
      changedAt: null,
    }));
    const html = render(<Visuals />);
    expect(
      html.match(
        /<button type="button" class="btn btn-small" disabled>Use defaults/g,
      ),
    ).toHaveLength(2);
  });

  test.serial("off: the saved state in the line, the row off", () => {
    tools.value = response({ enabled: false, hosts: [] });
    limits.value = rows;
    const html = render(<Visuals />);
    expect(html).toContain('aria-label="Visuals off"');
    expect(html).toContain(visualsLine(false));
    expect(html).toContain("No CDNs. Visuals use inline code only.");
    expect(html).toMatch(/setting-count">0 of 16</);
    // the other cards stay editable while it is off
    expect(html).not.toMatch(/<textarea name="hosts"[^>]*disabled/);
    const row = render(
      <ToolRow
        tool={{ ...visual, enabled: false }}
        open={false}
        onToggle={() => {}}
      />,
    );
    expect(row).toContain("rows-item-off");
    expect(row).toContain('rows-meta-long">Off<');
    expect(row).not.toContain('role="switch"');
  });

  test.serial("the aside counts the last 30 days, or says it failed", () => {
    tools.value = response();
    limits.value = rows;
    visualsUsage.value = {
      usage: { since: 0, until: 1, drawn: 12, failed: 1, opened: 3 },
    };
    const html = render(<Visuals />);
    expect(html).toMatch(/Drawn<span class="split-strong">12</);
    expect(html).toMatch(/Failed<span class="split-strong">1</);
    expect(html).toMatch(/Files opened<span class="split-strong">3</);
    visualsUsage.value = { usage: null };
    expect(render(<Visuals />)).toContain("Did not load.");
  });

  test.serial("says it is loading, then the failure", () => {
    tools.value = null;
    limits.value = null;
    expect(render(<Visuals />)).toContain("Loading");
    toolsError.value = {
      words: "the server failed while answering",
      status: 500,
    };
    expect(render(<Visuals />)).toContain("The server failed while answering.");
  });
});
