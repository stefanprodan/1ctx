// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  loadOpened,
  openedFiles,
  resetValues,
  syncValues,
  toolVisuals,
} from "../../../src/client/data/session-values.ts";
import { FileCard } from "../../../src/client/transcript/FileCard.tsx";
import {
  groupRows,
  type ReplyNode,
} from "../../../src/client/transcript/rows.ts";
import {
  fileKey,
  isFileCard,
  visualCards,
  visualKey,
} from "../../../src/client/transcript/visuals.ts";
import {
  BASH_ROW,
  openedAnswer,
  openedDetail,
  opens,
} from "../../fixtures/sessions/opened-client.ts";

const nodeOf = (detail = openedDetail()): ReplyNode =>
  groupRows(detail.messages, detail.send)[0] as ReplyNode;

const cardsOf = (detail = openedDetail()) =>
  visualCards(nodeOf(detail), new Map());

const markdown = {
  kind: "file" as const,
  key: fileKey(BASH_ROW, 1),
  messageId: BASH_ROW,
  index: 1,
  file: opens[1]!,
};
const code = {
  kind: "file" as const,
  key: fileKey(BASH_ROW, 2),
  messageId: BASH_ROW,
  index: 2,
  file: opens[2]!,
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetValues();
});

test("a bash row's opens are cards in open order, before the next call's visual", () => {
  const cards = cardsOf();
  expect(cards.map((card) => card.key)).toEqual([
    fileKey(BASH_ROW, 0),
    fileKey(BASH_ROW, 1),
    fileKey(BASH_ROW, 2),
    visualKey("reply0000001", 1),
  ]);
  expect(cards.map((card) => isFileCard(card))).toEqual([
    false,
    true,
    true,
    false,
  ]);
  const visual = cards[0];
  expect(isFileCard(visual)).toBe(false);
  if (isFileCard(visual)) return;
  // an opened visual is the frame's card, titled by the page
  expect(visual).toMatchObject({
    messageId: BASH_ROW,
    callIndex: 0,
    title: "Deploys",
    source: { kind: "file", index: 0 },
  });
  expect(visual.preview).toBeUndefined();
  expect(visual.result?.id).toBe(BASH_ROW);
  expect(fileKey(BASH_ROW, 0)).not.toBe(visualKey(BASH_ROW, 0));
});

test("an exit 1 keeps its opens, a stopped row and a row without any have none", () => {
  expect(cardsOf(openedDetail({ status: "failed" }))).toHaveLength(4);
  expect(
    cardsOf(openedDetail({ status: "stopped", files: null })),
  ).toHaveLength(1);
  expect(cardsOf(openedDetail({ files: null }))).toHaveLength(1);
});

test("a visual file with no title of its own is named by its file", () => {
  const detail = openedDetail({
    files: [{ ...opens[0]!, title: null, path: "/tmp/a/chart.html" }],
  });
  const card = cardsOf(detail)[0]!;
  expect(isFileCard(card) ? null : card.title).toBe("chart.html");
});

test.serial("a file card asks for its text once and folds a long file", () => {
  openedFiles.value = new Map([
    [markdown.key, { status: "done" as const, ...openedAnswer(opens[1]!) }],
    [code.key, { status: "done" as const, ...openedAnswer(opens[2]!) }],
  ]);
  const html = render(<FileCard card={markdown} />);
  expect(html).toContain("/knowledge/plans/open.md");
  expect(html).toContain('<p class="md-p">the plan</p>');
  expect(html).toContain("filecard-clip");
  // Markdown's blank lines collapse, so only the measure cuts it
  expect(html).not.toContain("Show all");
  // Copy carries the source, never the rendering
  expect(html).toContain('title="Copy"');
  // code draws a line per source line: its count cuts it at once
  const long = render(
    <FileCard card={{ ...code, file: { ...code.file, lines: 40 } }} />,
  );
  expect(long).toContain("Show all 40 lines");
});

test.serial("a short code file carries its language and no fold", () => {
  openedFiles.value = new Map([
    [code.key, { status: "done" as const, ...openedAnswer(opens[2]!) }],
  ]);
  const html = render(<FileCard card={code} />);
  expect(html).toContain('<span class="tag">yaml</span>');
  // the code is Source's numbered lines, one per line of the text,
  // numbers no link in a chat
  expect(html).toContain('class="source"');
  expect(html).toContain(
    '<span class="source-num" aria-hidden="true">1</span><span class="source-text"><span class="hljs-string">on</span>: true</span>',
  );
  expect(html).not.toContain(">2</span>");
  // the cut is on the body, so the measure can see what it hides; a
  // file shorter than the fold offers nothing to open
  expect(html).toContain("filecard-clip");
  expect(html).not.toContain("Show all");
});

test.serial(
  "a file that is loading or failed says so and offers no Copy",
  () => {
    openedFiles.value = new Map([[code.key, { status: "loading" as const }]]);
    const loading = render(<FileCard card={code} />);
    expect(loading).toContain("Loading");
    expect(loading).not.toContain('title="Copy"');
    openedFiles.value = new Map([
      [
        code.key,
        { status: "failed" as const, error: "This is no longer there." },
      ],
    ]);
    const failed = render(<FileCard card={code} />);
    expect(failed).toContain("filecard-error");
    expect(failed).toContain("This is no longer there.");
  },
);

test.serial(
  "syncValues keeps a tool row's file keys and drops the rest",
  () => {
    const detail = openedDetail();
    syncValues(detail);
    openedFiles.value = new Map([
      [code.key, { status: "done" as const, ...openedAnswer(opens[2]!) }],
      [fileKey(BASH_ROW, 7), { status: "loading" as const }],
      [fileKey("gone00000001", 0), { status: "loading" as const }],
    ]);
    toolVisuals.value = new Map([
      [fileKey(BASH_ROW, 0), { status: "loading" as const }],
      [fileKey("gone00000001", 1), { status: "loading" as const }],
    ]);
    syncValues(openedDetail());
    expect([...openedFiles.value.keys()]).toEqual([code.key]);
    expect([...toolVisuals.value.keys()]).toEqual([fileKey(BASH_ROW, 0)]);
  },
);

test.serial(
  "an opened visual joins the visuals and a code file its own map",
  async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      const index = Number(url.slice(url.lastIndexOf("/") + 1));
      return new Response(JSON.stringify(openedAnswer(opens[index]!)), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    syncValues(openedDetail());
    await loadOpened(BASH_ROW, 0);
    await loadOpened(BASH_ROW, 2);
    expect(asked).toEqual([
      `/api/sessions/session00001/messages/${BASH_ROW}/files/0`,
      `/api/sessions/session00001/messages/${BASH_ROW}/files/2`,
    ]);
    expect(toolVisuals.value.get(fileKey(BASH_ROW, 0))).toEqual({
      status: "done",
      title: "Deploys",
      html: "<h1>Deploys</h1>",
    });
    expect(openedFiles.value.get(fileKey(BASH_ROW, 2))).toMatchObject({
      status: "done",
      kind: "code",
      language: "yaml",
      text: "on: true\n",
    });
    // the answer is held: a second card asks nothing
    await loadOpened(BASH_ROW, 0);
    expect(asked).toHaveLength(2);
    // an index the row does not carry is never asked for
    await loadOpened(BASH_ROW, 9);
    expect(asked).toHaveLength(2);
  },
);

test.serial(
  "a refused file keeps the server's words under its key",
  async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "this is no longer there" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    syncValues(openedDetail());
    await loadOpened(BASH_ROW, 1);
    expect(openedFiles.value.get(fileKey(BASH_ROW, 1))).toEqual({
      status: "failed",
      error: "This is no longer there.",
    });
  },
);
