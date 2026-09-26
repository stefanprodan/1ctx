// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The file page's other parts as they first draw: the reader's Preview
// and Source and its visual gate, a past revision's steps and its
// change, the editor's counts, a new file, a deleted file and none.

import { afterEach, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { switchable } from "../../../../../src/client/data/capabilities.ts";
import { lists } from "../../../../../src/client/data/knowledge.ts";
import {
  docHistories,
  docVersions,
} from "../../../../../src/client/data/knowledge-history.ts";
import { MAX_DIFF_LINES } from "../../../../../src/client/lib/diff.ts";
import {
  DeletedDoc,
  NotFound,
} from "../../../../../src/client/views/knowledge/file/Deleted.tsx";
import {
  changeCounts,
  EditorBand,
} from "../../../../../src/client/views/knowledge/file/Editor.tsx";
import { NewFile } from "../../../../../src/client/views/knowledge/file/NewFile.tsx";
import { Reader } from "../../../../../src/client/views/knowledge/file/Reader.tsx";
import { Revision } from "../../../../../src/client/views/knowledge/file/Revision.tsx";
import { fileView, list, sre, versionView } from "./fixtures.ts";

afterEach(() => {
  switchable.value = null;
  lists.value = new Map();
  docHistories.value = new Map();
  docVersions.value = new Map();
});

const HREF = "/projects/p1/knowledge/files/f1";

test("Markdown reads rendered, with Preview and Source; ?line= is Source", () => {
  const md = fileView({
    name: "plans/a.md",
    kind: "md",
    text: "# A\n\n## B\n",
    html: '<h1 class="md-h1">A</h1><h2 class="md-h2">B</h2>',
  });
  const html = render(<Reader file={md} href={HREF} line={null} now={0} />);
  expect(html).toContain('class="docpage-md md-wide"');
  expect(html).toContain(">Preview</button>");
  expect(html).toContain('aria-pressed="true">Preview');
  // two headings are no outline
  expect(html).not.toContain('aria-label="Outline"');
  const lit = render(<Reader file={md} href={HREF} line={2} now={0} />);
  expect(lit).not.toContain('class="docpage-md md-wide"');
  expect(lit).toContain('class="source-num source-lit"');
  expect(lit).toContain('aria-pressed="true">Source');
});

test.serial("HTML draws as a visual only while visualize is switchable", () => {
  const page = fileView({
    name: "v/a.html",
    kind: "html",
    text: "<p>hi</p>",
  });
  const off = render(<Reader file={page} href={HREF} line={null} now={0} />);
  expect(off).not.toContain("visual-card");
  expect(off).not.toContain(">Preview</button>");
  switchable.value = ["web", "visualize"];
  const on = render(<Reader file={page} href={HREF} line={null} now={0} />);
  expect(on).toContain('class="docpage-visual"');
  expect(on).toContain('src="/api/visual"');
  expect(on).not.toContain("visual-head");
});

const versions = [3, 2, 1].map((n) => ({
  ...versionView(n, `a: ${n}\n`),
  text: undefined,
}));

function hold(texts: Record<number, string>): void {
  docHistories.value = new Map([
    [
      "f1",
      {
        state: "done",
        versions: versions.map(({ text: _, ...v }) => v),
      },
    ],
  ]);
  docVersions.value = new Map(
    Object.entries(texts).map(([n, text]) => [
      `v${n}`,
      { state: "done", version: versionView(Number(n), text) },
    ]),
  );
}

test.serial("a past revision: its steps and what it changed", () => {
  hold({ 1: "a: 1\n", 2: "a: 2\n" });
  const html = render(
    <Revision
      file={fileView()}
      history={{
        state: "done",
        versions: versions.map(({ text: _, ...v }) => v),
      }}
      revision={2}
      now={0}
    />,
  );
  expect(html).toContain("Revision 2 of 3");
  expect(html).toContain(`href="${HREF}?revision=1"`);
  // the newer step would be the file as it is: none
  expect(html).not.toContain(`href="${HREF}?revision=3"`);
  expect(html).toContain("What revision 2 changed from revision 1");
  expect(html).toContain('class="diff"');
});

test.serial("a change too large to compare offers the text alone", () => {
  const big = "x\n".repeat(MAX_DIFF_LINES);
  hold({ 1: big, 2: `${big}y\n` });
  const html = render(
    <Revision
      file={fileView()}
      history={{
        state: "done",
        versions: versions.map(({ text: _, ...v }) => v),
      }}
      revision={2}
      now={0}
    />,
  );
  expect(html).toContain("Too large to compare");
  expect(html).not.toContain(">Changes</button>");
  expect(html).toContain('class="source"');
});

test("the editor counts lines added and removed", () => {
  expect(changeCounts("a\nb\n", "a\nb\n")).toBe("same");
  expect(changeCounts("a\nb\n", "a\nc\nd\n")).toEqual({
    added: 2,
    removed: 1,
  });
  const big = "x\n".repeat(MAX_DIFF_LINES);
  expect(changeCounts(big, `${big}y\n`)).toBeNull();
  const band = render(
    <EditorBand revision={3} before="a" text="ab" cap={262144} />,
  );
  expect(band).toContain("Editing revision 3");
  expect(band).toContain("2 B of 256 KB");
});

test.serial(
  "a new file starts in its folder, the size against the limit",
  () => {
    lists.value = new Map([["p1", list()]]);
    const html = render(
      <NewFile projectId="p1" projectName="personal" folder="plans" />,
    );
    expect(html).toContain('value="plans/"');
    expect(html).toContain("0 B of 256 KB");
    expect(html).toContain(`placeholder="The file's text"`);
    expect(html).toContain("6 files · 6.6K tokens");
    expect(html).toMatch(/form="docpage-new"[^>]*disabled/);
  },
);

test.serial("a new file's crumb leads to each folder it sits in", () => {
  lists.value = new Map([["p1", list()]]);
  const html = render(
    <NewFile projectId="p1" projectName="personal" folder="plans/deploy" />,
  );
  expect(html).toContain('href="/projects/p1/knowledge?folder=plans"');
  expect(html).toContain('href="/projects/p1/knowledge?folder=plans%2Fdeploy"');
  expect(html).not.toContain("?folder=deploy");
});

test.serial(
  "a deleted file: its last text, Restore, how long it is kept",
  () => {
    lists.value = new Map([["p1", list()]]);
    hold({ 3: "a: 3\n" });
    const row = {
      ...fileView(),
      deletedBy: sre,
      deletedAt: 0,
    };
    const { text: _t, language: _l, html: _h, code: _c, ...file } = row;
    const html = render(
      <DeletedDoc
        projectId="p1"
        projectName="personal"
        row={file}
        now={60_000}
      />,
    );
    expect(html.replace(/<[^>]*>/g, "")).toContain(
      "Deleted by @sre in a chat 1m ago. Agents do not see it. Its text is kept up to 90 days.",
    );
    expect(html).toContain("Revision 3");
    expect(html).toContain(">Restore</button>");
  },
);

test("no file: the ways back", () => {
  const html = render(<NotFound projectId="p1" projectName="personal" />);
  expect(html).toContain("No file at this address.");
  expect(html).toContain('class="card rows-card"');
  expect(html).toContain('href="/projects/p1/knowledge?list=deleted"');
  expect(html).toContain('href="/projects/p1/knowledge"');
});
