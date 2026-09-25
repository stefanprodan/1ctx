// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The file page's words that link: who wrote, and the head's notices.

import { expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  DeleteAsk,
  ProblemNotice,
  WroteNotice,
} from "../../../../../src/client/views/knowledge/file/Notices.tsx";
import type { KnowledgeAuthor } from "../../../../../src/shared/contracts/knowledge.ts";

const sre: KnowledgeAuthor = {
  kind: "agent",
  id: "a1",
  name: "sre",
  sessionId: "s1",
  origin: "chat",
};
const admin: KnowledgeAuthor = {
  kind: "user",
  id: "u1",
  name: "admin",
  sessionId: null,
  origin: null,
};

test("another writer's word says who, what and when", () => {
  const html = render(
    <WroteNotice
      author={sre}
      at={0}
      now={60_000}
      verb="changed"
      after=" Saving replaces their change."
      failed
    />,
  );
  expect(html).toContain('class="page-notice page-notice-failed"');
  expect(html).toContain('href="/agents/sre"');
  expect(html).toContain('href="/chat/s1"');
  expect(html.replace(/<[^>]*>/g, "")).toBe(
    "@sre in a chat changed this file 1m ago. Saving replaces their change.",
  );
});

test("a refusal names the action and carries the status", () => {
  const html = render(
    <ProblemNotice
      problem={{
        error: "a file named x.md exists",
        action: "restore",
        status: 409,
      }}
    />,
  );
  expect(html.replace(/<[^>]*>/g, "")).toBe(
    "Could not restore. A file named x.md exists. HTTP 409",
  );
});

test("the delete asks with the history's days, if known", () => {
  const html = render(
    <DeleteAsk
      days={90}
      busy={false}
      deleting={false}
      onKeep={() => {}}
      onDelete={() => {}}
    />,
  );
  expect(html).toContain(
    "Delete this file? Agents stop seeing it. Its text is kept up to 90 days.",
  );
  expect(html).toContain(">Keep</button>");
  expect(html).toContain('class="btn btn-small btn-danger">Delete</button>');
  const unknown = render(
    <DeleteAsk
      days={null}
      busy={false}
      deleting={false}
      onKeep={() => {}}
      onDelete={() => {}}
    />,
  );
  expect(unknown).toContain("Delete this file? Agents stop seeing it.</span>");
});

test("a person is their handle, linked to their page", () => {
  const html = render(
    <WroteNotice author={admin} at={0} now={0} verb="deleted" />,
  );
  expect(html).toContain('href="/users/admin"');
  expect(html.replace(/<[^>]*>/g, "")).toBe("@admin deleted this file 0s ago.");
});
