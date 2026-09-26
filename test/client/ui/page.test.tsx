// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The head of a view: the forms every caller draws stay as they were,
// and a crumb of steps and the head's notice.

import { expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Page, PageNotice } from "../../../src/client/ui/Page.tsx";

const ALERT =
  '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="page-failed-icon" aria-hidden="true"><path d="M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM8 4.75v3.75M8 11h.01"></path></svg>';

test("a label, a crumb, a menu and a failure draw as they always have", () => {
  expect(
    render(
      <Page
        label="Admin"
        title="Users"
        actions={<button type="button">New</button>}
      >
        <p>x</p>
      </Page>,
    ),
  ).toBe(
    '<div class="page"><div class="page-head"><div class="page-heading"><span class="label">Admin</span><h1 class="page-title">Users</h1></div><div class="page-actions"><button type="button">New</button></div></div><p>x</p></div>',
  );
  expect(
    render(
      <Page crumb="Account" crumbHref="/profile" title="Profile" loading />,
    ),
  ).toBe(
    '<div class="page"><div class="page-head"><h1 class="page-crumb label"><a class="page-crumb-up" href="/profile">Account</a><span class="page-crumb-sep">/</span><span class="page-crumb-on">Profile</span></h1></div><p class="page-state">Loading</p></div>',
  );
  expect(render(<Page crumb="" title="Home" empty="Nothing yet" />)).toBe(
    '<div class="page"><div class="page-head"><h1 class="page-crumb label"><span class="page-crumb-on">Home</span></h1></div><p class="page-state">Nothing yet</p></div>',
  );
  expect(
    render(
      <Page
        crumb="Chats"
        title="t"
        menu={<button type="button">t</button>}
        error="gone"
        flush
      />,
    ),
  ).toBe(
    '<div class="page page-flush"><div class="page-head"><div class="page-crumb label"><span>Chats</span><span class="page-crumb-sep">/</span><div class="page-crumb-on page-crumb-menu"><button type="button">t</button></div></div></div><div class="notice-failed page-failed" role="alert">' +
      ALERT +
      '<div class="page-failed-words"><p class="page-failed-title">This page did not load</p><p class="page-failed-text">Gone.</p></div><button type="button" class="btn page-failed-retry">Try again</button></div></div>',
  );
  expect(render(<Page title="x" error={{ words: "bad", status: 409 }} />)).toBe(
    '<div class="page"><div class="page-head"><div class="page-heading"><h1 class="page-title">x</h1></div></div><div class="notice-failed page-failed" role="alert">' +
      ALERT +
      '<div class="page-failed-words"><p class="page-failed-title">This page did not load<span class="code-tag">HTTP 409</span></p><p class="page-failed-text">Bad.</p></div><button type="button" class="btn page-failed-retry">Try again</button></div></div>',
  );
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
  expect(html).toBe(
    '<div class="page"><div class="page-head"><h1 class="page-crumb label">' +
      '<a class="page-crumb-up page-crumb-far" href="/projects/p1">personal</a>' +
      '<span class="page-crumb-sep page-crumb-far">/</span>' +
      '<a class="page-crumb-up page-crumb-far" href="/projects/p1/knowledge">Knowledge</a>' +
      '<span class="page-crumb-sep page-crumb-far">/</span>' +
      '<a class="page-crumb-up page-crumb-path page-crumb-far" href="/projects/p1/knowledge?open=plans">plans</a>' +
      '<span class="page-crumb-sep page-crumb-far">/</span>' +
      '<span class="page-crumb-up page-crumb-path">research</span>' +
      '<span class="page-crumb-sep">/</span>' +
      '<span class="page-crumb-on page-crumb-path" title="notes.md">notes.md</span>' +
      "</h1></div></div>",
  );
});

test("a notice spans the head after the actions, a refusal read out at once", () => {
  const html = render(
    <Page
      steps={[{ label: "Knowledge", href: "/k" }]}
      title="New file"
      notice={
        <PageNotice tone="failed" words="Could not restore.">
          <button type="button">Open it</button>
        </PageNotice>
      }
    />,
  );
  expect(html).toBe(
    '<div class="page"><div class="page-head page-head-notice">' +
      '<h1 class="page-crumb label"><a class="page-crumb-up" href="/k">Knowledge</a>' +
      '<span class="page-crumb-sep">/</span><span class="page-crumb-on">New file</span></h1>' +
      '<div class="page-notice page-notice-failed" role="alert">' +
      '<span class="page-notice-words">Could not restore.</span>' +
      '<span class="page-notice-acts"><button type="button">Open it</button></span>' +
      "</div></div></div>",
  );
  expect(render(<PageNotice words="An unsaved edit." />)).toBe(
    '<div class="page-notice" role="status"><span class="page-notice-words">An unsaved edit.</span></div>',
  );
});
