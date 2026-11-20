// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A file page waits as one wait: the file's text in bones from the
// first load to a deleted file's last text, and from a /knowledge/
// path's page to the file's it moves to, with "Still loading" one
// second after the wait began, not after each page took it up. Every
// step is on the fake clock, the pages mounted so their hooks run.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "preact/test-utils";
import { query } from "../../../../../src/client/app/router.ts";
import { lists } from "../../../../../src/client/data/knowledge.ts";
import { docFiles } from "../../../../../src/client/data/knowledge-file.ts";
import {
  docHistories,
  docVersions,
} from "../../../../../src/client/data/knowledge-history.ts";
import {
  pathAnswer,
  pathKey,
} from "../../../../../src/client/data/knowledge-path.ts";
import { project } from "../../../../../src/client/data/projects.ts";
import type { DayClock } from "../../../../../src/client/lib/now.ts";
import {
  CARRY_MS,
  dropCarried,
  SLOW_MS,
} from "../../../../../src/client/lib/slow.ts";
import { setWaitClock } from "../../../../../src/client/lib/wait.ts";
import {
  DocPage,
  PathDoc,
} from "../../../../../src/client/views/knowledge/file/DocPage.tsx";
import type { ProjectDetail } from "../../../../../src/shared/contracts/project.ts";
import { fakeClock, mount } from "../../../../helpers/mount.ts";
import { fileView, list, sre, versionView } from "./fixtures.ts";

const detail: ProjectDetail = {
  id: "p1",
  kind: "team",
  name: "infra",
  createdAt: 0,
  memberCount: 1,
  description: "",
  members: [],
  labels: [],
  chats: 0,
  knowledge: { files: 0, tokens: 0 },
  latestFiles: [],
  backend: null,
  instanceBackend: "builtin" as const,
  variant: null,
  instanceVariant: "python" as const,
};

const { text: _t, language: _l, html: _h, code: _c, ...row } = fileView();
const gone = { ...row, deletedBy: sre, deletedAt: 0 };

let clock: ReturnType<typeof fakeClock>;
let was: DayClock;
const g = globalThis as Record<string, unknown>;
const globals = { location: g.location, history: g.history };

beforeEach(() => {
  clock = fakeClock();
  was = setWaitClock(clock);
  dropCarried();
  project.value = detail;
  // the path page moves on with navigate(), which reads these
  Object.assign(g, {
    location: { origin: "http://127.0.0.1" },
    history: { replaceState() {}, pushState() {} },
  });
});

afterEach(() => {
  setWaitClock(was);
  dropCarried();
  project.value = null;
  lists.value = new Map();
  docFiles.value = new Map();
  docHistories.value = new Map();
  docVersions.value = new Map();
  pathAnswer.value = null;
  query.value = "";
  Object.assign(g, globals);
});

const slowWords = (html: string) => html.includes(">Still loading<");

test.serial(
  "a deleted file waits in one shape, and says so a second after it began",
  async () => {
    const view = await mount(<DocPage params={{ id: "p1", fileId: "f1" }} />);
    // the file's text in bones from the start, never generic rows
    expect(view.html()).toContain('aria-label="Loading the file"');
    expect(view.html()).not.toContain("rows-waiting");
    expect(view.html()).not.toContain(">Knowledge</span><span");
    await clock.advance(600);
    // the file is gone: the second phase reads its last text
    await act(() => {
      lists.value = new Map([["p1", list({ deleted: [gone] })]]);
      docFiles.value = new Map([["f1", { state: "missing" }]]);
    });
    const second = view.html();
    expect(second).toContain('aria-label="Loading the file"');
    expect(second).toContain(">x.yaml<");
    // bones drawn anew under a wait already shown skip their reveal
    expect(second).toContain("bones-waited");
    expect(slowWords(second)).toBe(false);
    await clock.advance(SLOW_MS - 600);
    expect(slowWords(view.html())).toBe(true);
    await act(() => {
      docHistories.value = new Map([
        ["f1", { state: "done", versions: [versionView(3, "a: 3\n")] }],
      ]);
      docVersions.value = new Map([
        ["v3", { state: "done", version: versionView(3, "a: 3\n") }],
      ]);
    });
    expect(view.html()).toContain("Revision 3");
    expect(slowWords(view.html())).toBe(false);
    expect(view.html()).not.toContain("bones-lines");
    await view.unmount();
  },
);

test.serial(
  "a path's page hands its wait to the file's page it moves to",
  async () => {
    query.value = "?name=apps/x.yaml";
    const path = await mount(<PathDoc params={{ id: "p1" }} />);
    expect(path.html()).toContain('aria-label="Loading the file"');
    expect(path.html()).toContain(">x.yaml<");
    await clock.advance(700);
    await act(() => {
      pathAnswer.value = {
        key: pathKey("p1", "apps/x.yaml"),
        answer: { state: "found", fileId: "f1" },
      };
    });
    // the router draws the file's page in its place
    await path.update(<DocPage params={{ id: "p1", fileId: "f1" }} />);
    expect(path.html()).toContain('aria-label="Loading the file"');
    expect(slowWords(path.html())).toBe(false);
    await clock.advance(SLOW_MS - 700);
    expect(slowWords(path.html())).toBe(true);
    await path.unmount();
  },
);

test.serial("a wait left behind past CARRY_MS starts afresh", async () => {
  const first = await mount(<DocPage params={{ id: "p1", fileId: "f1" }} />);
  await clock.advance(900);
  await first.unmount();
  await clock.advance(CARRY_MS + 1);
  const again = await mount(<DocPage params={{ id: "p1", fileId: "f1" }} />);
  await clock.advance(200);
  expect(slowWords(again.html())).toBe(false);
  expect(again.html()).not.toContain("bones-waited");
  await clock.advance(SLOW_MS - 200);
  expect(slowWords(again.html())).toBe(true);
  await again.unmount();
});
