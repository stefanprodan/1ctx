// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Page, PageNotice } from "../../../src/client/ui/Page.tsx";

test("a label, linked crumb, menu and failure keep their controls", () => {
  const labelled = render(
    <Page
      label="Admin"
      title="Users"
      actions={<button type="button">New</button>}
    >
      <p>x</p>
    </Page>,
  );
  expect(labelled).toContain(">Admin<");
  expect(labelled).toMatch(/<h1\b[^>]*>Users<\/h1>/);
  expect(labelled).toMatch(/<button\b[^>]*type="button"[^>]*>New<\/button>/);
  expect(labelled).toContain("<p>x</p>");
  const loading = render(
    <Page crumb="Account" crumbHref="/profile" title="Profile" loading />,
  );
  expect(loading).toMatch(/<h1\b[^>]*>[\s\S]*>Profile<[\s\S]*<\/h1>/);
  expect(loading).toMatch(/<a\b[^>]*href="\/profile"[^>]*>Account<\/a>/);
  expect(loading).toContain(">Loading<");
  const empty = render(<Page crumb="" title="Home" empty="Nothing yet" />);
  expect(empty).toMatch(/<h1\b[^>]*>[\s\S]*>Home<[\s\S]*<\/h1>/);
  expect(empty).toContain(">Nothing yet<");
  expect(empty).not.toContain("<a ");
  const menu = render(
    <Page
      crumb="Chats"
      title="t"
      menu={<button type="button">t</button>}
      error="gone"
      flush
    />,
  );
  expect(menu).toContain("page-flush");
  expect(menu).toContain(">Chats<");
  expect(menu).toMatch(/<button\b[^>]*type="button"[^>]*>t<\/button>/);
  expect(menu).not.toContain("<h1");
  const failed = render(
    <Page title="x" error={{ words: "bad", status: 409 }} />,
  );
  for (const [html, words] of [
    [menu, "Gone."],
    [failed, "Bad."],
  ]) {
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/class="page-failed-icon" aria-hidden="true"/);
    expect(html).toContain("This page did not load");
    expect(html).toContain(words);
    expect(html).toMatch(
      /<button\b[^>]*type="button"[^>]*>Try again<\/button>/,
    );
  }
  expect(failed).toMatch(/<h1\b[^>]*>x<\/h1>/);
  expect(failed).toContain(">HTTP 409<");
  expect(menu).not.toContain("HTTP ");
});

test("a crumb of steps links back, keeps a path's case and folds far steps", () => {
  const html = render(
    <Page
      steps={[
        { label: "personal", href: "/projects/p1" },
        { label: "Knowledge", href: "/projects/p1/knowledge" },
        {
          label: "plans",
          href: "/projects/p1/knowledge?open=plans",
          mono: true,
        },
        { label: "research", mono: true },
      ]}
      title="notes.md"
      titleMono
    />,
  );
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "";
  const links = [...heading.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)];
  expect(links.map((m) => m[2])).toEqual(["personal", "Knowledge", "plans"]);
  for (const [index, href] of [
    "/projects/p1",
    "/projects/p1/knowledge",
    "/projects/p1/knowledge?open=plans",
  ].entries()) {
    expect(links[index]![1]).toContain(`href="${href}"`);
    expect(links[index]![1]).toContain("page-crumb-far");
  }
  expect(links[2]![1]).toContain("page-crumb-path");
  const near = [
    ...heading.matchAll(/<span\b([^>]*)>(research|notes.md)<\/span>/g),
  ];
  expect(near.map((m) => m[2])).toEqual(["research", "notes.md"]);
  for (const [, attrs] of near) {
    expect(attrs).toContain("page-crumb-path");
    expect(attrs).not.toContain("page-crumb-far");
  }
  expect(near[1]![1]).toContain('title="notes.md"');
  expect(near[0]![1]).toContain("page-crumb-up");
  // the far separators fold away with their steps at narrow width
  const seps = [...heading.matchAll(/<span\b([^>]*)>\/<\/span>/g)];
  expect(seps).toHaveLength(4);
  for (const [index, [, attrs]] of seps.entries()) {
    expect(attrs).toContain("page-crumb-sep");
    if (index < 3) expect(attrs).toContain("page-crumb-far");
    else expect(attrs).not.toContain("page-crumb-far");
  }
});

test("a notice spans the head after the actions, a refusal read out at once", () => {
  const html = render(
    <Page
      steps={[{ label: "Knowledge", href: "/k" }]}
      title="New file"
      actions={<button type="button">Save</button>}
      notice={
        <PageNotice tone="failed" words="Could not restore.">
          <button type="button">Open it</button>
        </PageNotice>
      }
    />,
  );
  expect(html).toContain("page-head-notice");
  expect(html).toMatch(/<a\b[^>]*href="\/k"[^>]*>Knowledge<\/a>/);
  expect(html).toContain(">New file<");
  expect(html).toContain('role="alert"');
  expect(html).toContain("Could not restore.");
  expect(html).toMatch(/<button\b[^>]*>Open it<\/button>/);
  expect(html.indexOf("Could not restore.")).toBeGreaterThan(
    html.indexOf(">Save<"),
  );
  const notice = render(<PageNotice words="An unsaved edit." />);
  expect(notice).toContain('role="status"');
  expect(notice).toContain("An unsaved edit.");
});
