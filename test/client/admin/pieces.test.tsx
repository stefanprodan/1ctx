// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { render } from "preact-render-to-string";
import { AgentLinks } from "../../../src/client/agents/AgentLinks.tsx";
import { overview, overviewError } from "../../../src/client/data/overview.ts";
import { Save } from "../../../src/client/lib/save.ts";
import {
  KeyFilesSection,
  overviewTotals,
  SpendLines,
  TopSection,
  UsageSection,
} from "../../../src/client/views/admin/AdminAside.tsx";
import { CatalogSearch } from "../../../src/client/views/admin/Agents.state.ts";
import {
  type HeldDrafts,
  holding,
  stepDrafts,
  stepShown,
} from "../../../src/client/views/admin/drafts.ts";
import { ModelPicker } from "../../../src/client/views/admin/ModelPicker.tsx";
import { NewCard } from "../../../src/client/views/admin/NewCard.tsx";
import { refreshLine } from "../../../src/client/views/admin/refresh.ts";
import type {
  OverviewResponse,
  OverviewTotals,
} from "../../../src/shared/api/admin.ts";
import type { AgentSummary } from "../../../src/shared/contracts/agent.ts";
import type { CatalogMatch } from "../../../src/shared/contracts/provider.ts";

const plain = (html: string) => html.replaceAll("<!-- -->", "");
const strip = (html: string) => plain(html).replace(/<svg.*?<\/svg>/g, "");
const noop = () => {};

afterEach(() => {
  overview.value = null;
  overviewError.value = null;
});

describe("the aside", () => {
  test("Last 30 days links to the Usage page", () => {
    expect(
      render(
        <UsageSection value={{ n: 3 }}>{(u) => <p>{u.n}</p>}</UsageSection>,
      ),
    ).toBe(
      '<section class="split-section"><div class="split-section-head"><span class="label">Last 30 days</span><span class="split-section-act"><a class="split-link" href="/admin/monitor/usage">Usage</a></span></div><p>3</p></section>',
    );
    expect(
      render(
        <UsageSection value={undefined} label="Personal, last 30 days">
          {() => null}
        </UsageSection>,
      ),
    ).toContain('<span class="label">Personal, last 30 days</span>');
  });

  test("spend lines: the count, tokens and cost, or not priced", () => {
    const html = plain(
      render(
        <SpendLines label="Answers" count={1200} tokens={5} cost={null} />,
      ),
    );
    expect(html).toContain('Answers<span class="split-strong">1.2K</span>');
    expect(html).toContain('Tokens<span class="split-strong">5</span>');
    expect(html).toContain('Cost<span class="split-strong">not priced</span>');
    expect(
      plain(
        render(<SpendLines label="Turns" count={1} tokens={1} cost={4.5} />),
      ),
    ).toContain('Cost<span class="split-strong">$4.50</span>');
  });

  test.serial("the overview's totals only for 30 days", () => {
    const totals = { turns: 1 } as OverviewTotals;
    expect(overviewTotals()).toBeUndefined();
    overview.value = { range: "7d", totals } as unknown as OverviewResponse;
    expect(overviewTotals()).toBeUndefined();
    overviewError.value = { words: "down", status: 503 };
    expect(overviewTotals()).toBeNull();
    overview.value = { range: "30d", totals } as unknown as OverviewResponse;
    expect(overviewTotals()).toBe(totals);
  });

  test("key files by name, each with what reads it", () => {
    const html = plain(
      render(
        <KeyFilesSection
          files={["mcp-z", "mcp-a"]}
          reader={(file) =>
            file === "mcp-a"
              ? { label: "flux", href: "/admin/config/mcp/flux" }
              : { label: "unused", quiet: true }
          }
        />,
      ),
    );
    expect(html).toBe(
      '<section class="split-section"><div class="split-section-head"><span class="label">Key files</span></div><div class="split-line">mcp-a.key<a class="split-strong cut" href="/admin/config/mcp/flux">flux</a></div><div class="split-line">mcp-z.key<span class="split-strong cut split-quiet">unused</span></div></section>',
    );
    expect(
      render(<KeyFilesSection files={[]} reader={() => ({ label: "" })} />),
    ).toContain('<p class="split-empty">None in the secrets directory.</p>');
  });

  test("the top five, and nothing for none", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((n) => ({ name: `s${n}`, value: n }));
    const html = render(<TopSection label="Most called" rows={rows} />);
    expect(html.match(/split-line/g)?.length).toBe(5);
    expect(html).not.toContain("s6");
    expect(render(<TopSection label="Most called" rows={[]} />)).toBe("");
  });
});

test("a failed refresh says why and when", () => {
  expect(refreshLine("timed out", 0, 3 * 86_400_000)).toBe(
    "Timed out. Last refresh 3d ago.",
  );
});

describe("NewCard", () => {
  const card = (taken: string | null) =>
    strip(
      render(
        <NewCard
          label="New server"
          create="Create server"
          cancel="/admin/config/mcp"
          save={new Save(async () => {})}
          ready
          taken={taken}
          first="name"
          onSubmit={noop}
        >
          <input name="name" />
        </NewCard>,
      ),
    );

  test("a form of one card, Cancel then Create", () => {
    const html = card(null);
    expect(html).toStartWith(
      '<form class="setting-stack"><section class="card setting" aria-label="New server"><div class="setting-body"><input name="name"/></div>',
    );
    expect(html).toContain(
      '<a class="btn" href="/admin/config/mcp">Cancel</a><button type="submit" class="btn btn-primary foot-submit">',
    );
  });

  test("a taken name says so and holds Create", () => {
    const html = card("flux");
    expect(html).toContain('<div class="foot foot-stack">');
    expect(html).toContain('<span class="error">flux is taken.</span>');
    expect(html).toContain('class="btn btn-primary foot-submit" disabled');
  });
});

describe("ModelPicker", () => {
  const match = (id: string, name = id): CatalogMatch => ({
    id,
    name,
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    tools: true,
    reasoning: false,
    thinkingRequired: false,
    reasoningKnown: false,
    described: true,
  });
  const picker = (
    over: Partial<Parameters<typeof ModelPicker>[0]> = {},
  ): string => {
    const search = new CatalogSearch(async () => []);
    return strip(
      render(
        <ModelPicker
          save={new Save(async () => {})}
          search={search}
          providers={[{ id: "p1", name: "openrouter" }]}
          providerId="p1"
          model={{ id: "acme/small", meta: "128K" }}
          changing={false}
          cancellable
          currentId="acme/small"
          matchMeta={() => "meta"}
          onChange={noop}
          onCancel={noop}
          onProvider={noop}
          onPick={noop}
          {...over}
        />,
      ),
    );
  };

  test("at rest: the id over the provider and the facts, and Change", () => {
    expect(picker()).toBe(
      '<div class="model-picker-model"><span class="model-picker-model-words"><span class="model-picker-model-id">acme/small</span><span class="model-picker-model-meta">openrouter · 128K</span></span><button type="button" class="btn">Change</button></div>',
    );
    expect(picker({ model: null })).toContain(
      '<span class="model-picker-model-meta">openrouter · no model picked</span>',
    );
  });

  test("changing: the search, the provider and Cancel; matches tag the current", () => {
    const search = new CatalogSearch(async () => []);
    search.query.value = "small";
    search.matches.value = [match("acme/small", "Small"), match("acme/big")];
    const html = picker({ changing: true, search });
    expect(html).toContain('<div class="model-picker-change">');
    expect(html).toContain(
      'placeholder="Type part of the model\'s name or id"',
    );
    expect(html).toContain(
      '<span class="model-picker-provider-key">Provider</span><span class="model-picker-provider-name">openrouter</span>',
    );
    expect(html).toContain('<button type="button" class="btn">Cancel</button>');
    expect(html).toContain('<div class="model-picker-results">');
    expect(html).toContain('<span class="cut">Small</span>');
    expect(html).toContain("current");
    expect(html.match(/rows-meta/g)?.length).toBe(2);
    expect(picker({ changing: true, cancellable: false })).not.toContain(
      "Cancel",
    );
    search.dispose();
  });
});

describe("drafts", () => {
  type Row = { id: string; name: string };
  const of = (row: Row) => ({ name: signal(row.name), row });

  test("one set per id; a changed row is followed", () => {
    const held = {
      current: null as HeldDrafts<Row, ReturnType<typeof of>> | null,
    };
    const followed: [string, string][] = [];
    const follow = (_d: unknown, before: Row, after: Row) => {
      followed.push([before.name, after.name]);
    };
    const a1 = { id: "a", name: "one" };
    const first = stepDrafts(held, a1, of, follow);
    expect(stepDrafts(held, a1, of, follow)).toBe(first);
    const a2 = { id: "a", name: "two" };
    expect(stepDrafts(held, a2, of, follow)).toBe(first);
    expect(followed).toEqual([["one", "two"]]);
    expect(stepDrafts(held, null, of, follow)).toBeNull();
    expect(stepDrafts(held, a2, of, follow)).toBe(first);
    expect(followed.length).toBe(1);
    expect(stepDrafts(held, { id: "b", name: "b" }, of, follow)).not.toBe(
      first,
    );
  });

  test("a renamed row holds the page by id; a deleted one is leaving", () => {
    const shown = { current: null as { id: string; key: string } | null };
    const name = (r: Row) => r.name;
    expect(stepShown(shown, null, "old", name)).toEqual({
      row: null,
      leaving: false,
    });
    const before = [{ id: "a", name: "old" }];
    expect(stepShown(shown, before, "old", name).row?.id).toBe("a");
    const renamed = [{ id: "a", name: "new" }];
    expect(stepShown(shown, renamed, "old", name)).toEqual({
      row: renamed[0]!,
      leaving: false,
    });
    expect(stepShown(shown, [], "old", name)).toEqual({
      row: null,
      leaving: true,
    });
    expect(stepShown(shown, renamed, "new", name).row?.id).toBe("a");
    expect(stepShown({ current: null }, [], "x", name).leaving).toBe(false);
  });

  test("holding sets the flag for the call, a throw included", async () => {
    const flag = signal(false);
    const seen: boolean[] = [];
    expect(
      await holding(flag, async () => {
        seen.push(flag.value);
        return 1;
      }),
    ).toBe(1);
    await expect(
      holding(flag, async () => {
        throw new Error("no");
      }),
    ).rejects.toThrow("no");
    expect(seen).toEqual([true]);
    expect(flag.value).toBe(false);
  });
});

test("agent links: avatar, mono @name, a sub line", () => {
  const agents = [
    { id: "a1", name: "scout", avatar: "bot" },
  ] as unknown as AgentSummary[];
  expect(
    strip(
      render(
        <AgentLinks
          agents={agents}
          href={(a) => `/admin/config/agents/${a.name}`}
          sub={() => "Read"}
        />,
      ),
    ),
  ).toContain('href="/admin/config/agents/scout"');
  const html = plain(
    render(
      <AgentLinks
        agents={agents}
        href={(a) => `/x/${a.name}`}
        sub={() => "Read"}
      />,
    ),
  );
  expect(html).toContain("@scout");
  expect(html).toContain("Read");
  expect(html).toContain("rows-name-mono");
});
