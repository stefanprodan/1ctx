// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An aside's section and a note's card wait in line bones at their
// lines' place, one status each that names what loads; their failure
// stays words.

import { afterEach, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { AgentsAside } from "../../../src/client/agents/AgentsAside.tsx";
import { week } from "../../../src/client/data/usage.ts";
import { WeekAside } from "../../../src/client/views/home/WeekAside.tsx";
import { Note } from "../../../src/client/views/memory/Note.tsx";

afterEach(() => {
  week.value = null;
});

function waits(html: string, label: string) {
  expect(html.match(/role="status"/g)?.length).toBe(1);
  expect(html).toContain(`aria-label="${label}"`);
  expect(html).toContain("bones-bone-line");
  expect(html).not.toContain(">Loading<");
}

test.serial("the week and the agents wait in their sections' lines", () => {
  week.value = null;
  const html = render(<WeekAside />);
  waits(html, "Loading the week");
  expect(html).toContain(">This week<");
  expect(html.split('class="split-line" aria-hidden="true"').length - 1).toBe(
    3,
  );
  waits(render(<AgentsAside agents={null} admin={false} />), "Loading agents");
  expect(render(<AgentsAside agents={[]} admin={false} />)).toContain(
    "No agents yet.",
  );
});

test("a note waits in its card, and says when it did not load", () => {
  const note = (error: { words: string; status: number } | null) =>
    render(
      <Note memory={null} memoryKey="k" error={error} empty="Nothing yet" />,
    );
  const html = note(null);
  waits(html, "Loading the memory");
  expect(html).toContain("note-empty");
  const failed = note({ words: "boom", status: 500 });
  expect(failed).toContain("Did not load. Boom.");
  expect(failed).not.toContain("bones-bone");
});
