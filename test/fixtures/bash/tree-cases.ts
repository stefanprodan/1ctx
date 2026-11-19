// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Trees as a command may leave them, with what the read-back rules make
// of each. Every shell backend lists its tree into these entries, so the
// same cases run against the rules and against each backend's listing.

import type { Job } from "../../../src/server/bash/protocol.ts";
import type {
  EntryKind,
  ReadBack,
  TreeMount,
} from "../../../src/server/bash/readback.ts";
import { READ_ONLY_TO_SUBAGENT } from "../../../src/server/bash/readback.ts";

export type CaseEntry = {
  path: string;
  kind: EntryKind;
  mode: number;
  text?: string;
  // a link's target
  target?: string;
};

export type TreeCase = {
  name: string;
  mount: TreeMount & Pick<Job, "cwd">;
  // the tree after the command, every path of the trees but /repos'
  // mounted repositories
  tree: CaseEntry[];
  exitCode?: number;
  pwd?: string;
  notice: string;
  // the read back; a refusal is matched as a substring
  expected:
    | ReadBack
    | { changes: null; refusedContains: string };
  // a tree only a real shell can leave, which just-bash cannot make
  realOnly?: boolean;
};

const bytes = (text: string) => new TextEncoder().encode(text);

const DOC = "hello\n";
const NOTES = "x";
const CSV = "1,2\n";
const KEPT = "/mcp/0001-read/result.txt";

export const baseMount = (): TreeCase["mount"] => ({
  docs: true,
  cwd: "/knowledge",
  knowledgeFileBytes: 1024 * 1024,
  knowledge: [{ name: "a.md", data: bytes(DOC), mtime: 1 }],
  scratch: [{ name: "notes.txt", data: bytes(NOTES), mode: 0o644, mtime: 1 }],
  uploads: [{ name: "in/data.csv", data: bytes(CSV), mtime: 1 }],
  kept: [KEPT],
});

const dir = (path: string): CaseEntry => ({ path, kind: "dir", mode: 0o755 });
const file = (path: string, text: string, mode = 0o644): CaseEntry => ({
  path,
  kind: "file",
  mode,
  text,
});

// the tree as mounted, unchanged
export const baseTree = (): CaseEntry[] => [
  dir("/knowledge"),
  file("/knowledge/a.md", DOC),
  dir("/tmp"),
  file("/tmp/notes.txt", NOTES),
  dir("/uploads"),
  dir("/uploads/in"),
  file("/uploads/in/data.csv", CSV),
  dir("/mcp"),
  dir("/mcp/0001-read"),
  file(KEPT, "kept"),
];

const without = (tree: CaseEntry[], ...paths: string[]) =>
  tree.filter((entry) => !paths.includes(entry.path));
const replaced = (tree: CaseEntry[], entry: CaseEntry) =>
  tree.map((each) => (each.path === entry.path ? entry : each));

const unchanged = (cwd = "/knowledge"): ReadBack => ({
  changes: { knowledge: [], written: [], removed: [], cwd },
  refused: null,
});

const UPLOADS =
  "changes under /uploads were discarded: copy a file to /tmp to change it\n";
const MCP =
  "changes under /mcp were discarded: copy a file to /tmp to change it\n";
const REPOS =
  "changes under /repos were discarded: copy a file to /tmp to change it\n";
const DOCS_OFF =
  "changes under /knowledge were discarded: the project docs are off\n";

export const TREE_CASES: TreeCase[] = [
  {
    name: "nothing changed",
    mount: baseMount(),
    tree: baseTree(),
    notice: "",
    expected: unchanged(),
  },
  {
    name: "a doc edited and one made in a folder",
    mount: baseMount(),
    tree: [
      ...replaced(baseTree(), file("/knowledge/a.md", "world\n")),
      dir("/knowledge/notes"),
      file("/knowledge/notes/b.md", "new\n"),
    ],
    notice: "",
    expected: {
      changes: {
        knowledge: [
          { name: "a.md", text: "world\n" },
          { name: "notes/b.md", text: "new\n" },
        ],
        written: [],
        removed: [],
        cwd: "/knowledge",
      },
      refused: null,
    },
  },
  {
    name: "a mounted doc gone is a delete",
    mount: baseMount(),
    tree: without(baseTree(), "/knowledge/a.md"),
    notice: "",
    expected: {
      changes: {
        knowledge: [{ name: "a.md", text: null }],
        written: [],
        removed: [],
        cwd: "/knowledge",
      },
      refused: null,
    },
  },
  {
    name: "scratch: a mode changed, a file added, a folder kept empty",
    mount: baseMount(),
    tree: [
      ...replaced(baseTree(), file("/tmp/notes.txt", NOTES, 0o755)),
      dir("/tmp/out"),
      file("/tmp/out/r.bin", "\u0000\u0001"),
      dir("/tmp/empty"),
    ],
    notice: "",
    expected: {
      changes: {
        knowledge: [],
        written: [
          { path: "notes.txt", data: bytes(NOTES), mode: 0o755 },
          { path: "out/r.bin", data: bytes("\u0000\u0001"), mode: 0o644 },
        ],
        removed: [],
        cwd: "/knowledge",
      },
      refused: null,
    },
  },
  {
    name: "a scratch file gone is removed",
    mount: baseMount(),
    tree: without(baseTree(), "/tmp/notes.txt"),
    notice: "",
    expected: {
      changes: { knowledge: [], written: [], removed: ["notes.txt"], cwd: "/knowledge" },
      refused: null,
    },
  },
  {
    name: "a link under /tmp refuses the save",
    mount: baseMount(),
    tree: [
      ...baseTree(),
      { path: "/tmp/link", kind: "link", mode: 0o777, target: "/knowledge" },
    ],
    notice: "",
    expected: { changes: null, refusedContains: "/tmp/link is not a regular file" },
  },
  {
    name: "a link under /knowledge refuses the save",
    mount: baseMount(),
    tree: [
      ...baseTree(),
      { path: "/knowledge/l.md", kind: "link", mode: 0o777, target: "/tmp/notes.txt" },
    ],
    notice: "",
    expected: { changes: null, refusedContains: "/knowledge/l.md is not a regular file" },
  },
  {
    name: "a special file refuses the save",
    mount: baseMount(),
    tree: [...baseTree(), { path: "/tmp/fifo", kind: "other", mode: 0o644 }],
    notice: "",
    expected: { changes: null, refusedContains: "/tmp/fifo is not a regular file" },
    realOnly: true,
  },
  {
    name: "/tmp removed refuses the save",
    mount: baseMount(),
    tree: without(baseTree(), "/tmp", "/tmp/notes.txt"),
    notice: "",
    expected: { changes: null, refusedContains: "ENOENT" },
  },
  {
    name: "/tmp a file refuses the save",
    mount: baseMount(),
    tree: [
      ...without(baseTree(), "/tmp", "/tmp/notes.txt"),
      file("/tmp", "file"),
    ],
    notice: "",
    expected: { changes: null, refusedContains: "/tmp is not a directory" },
  },
  {
    name: "a doc name outside the rule refuses the save",
    mount: baseMount(),
    tree: [...baseTree(), file("/knowledge/bad name.md", "x\n")],
    notice: "",
    expected: { changes: null, refusedContains: "name must be" },
  },
  {
    name: "a doc that is not text refuses the save",
    mount: baseMount(),
    tree: [...baseTree(), file("/knowledge/b.md", "\u0000")],
    notice: "",
    expected: { changes: null, refusedContains: "not a text file" },
  },
  {
    name: "a path listed twice refuses the save",
    mount: baseMount(),
    tree: [...baseTree(), file("/tmp/notes.txt", NOTES)],
    notice: "",
    expected: { changes: null, refusedContains: "/tmp/notes.txt was listed twice" },
    realOnly: true,
  },
  {
    name: "an upload changed is discarded, the rest saves",
    mount: baseMount(),
    tree: [
      ...replaced(baseTree(), file("/uploads/in/data.csv", "3,4\n")),
      file("/tmp/kept.txt", "y"),
    ],
    notice: UPLOADS,
    expected: {
      changes: {
        knowledge: [],
        written: [{ path: "kept.txt", data: bytes("y"), mode: 0o644 }],
        removed: [],
        cwd: "/knowledge",
      },
      refused: null,
    },
  },
  {
    name: "an upload listed without bytes reads as changed",
    mount: baseMount(),
    tree: replaced(baseTree(), {
      path: "/uploads/in/data.csv",
      kind: "file",
      mode: 0o644,
    }),
    notice: UPLOADS,
    expected: unchanged(),
    realOnly: true,
  },
  {
    name: "an upload removed is discarded",
    mount: baseMount(),
    tree: without(baseTree(), "/uploads/in/data.csv"),
    notice: UPLOADS,
    expected: unchanged(),
  },
  {
    name: "a subagent's upload change refuses its save",
    mount: { ...baseMount(), subagent: true },
    tree: [
      ...without(baseTree(), "/uploads/in/data.csv"),
      file("/tmp/kept.txt", "y"),
    ],
    notice: UPLOADS,
    expected: { changes: null, refused: READ_ONLY_TO_SUBAGENT },
  },
  {
    name: "a subagent's doc change refuses its save",
    mount: { ...baseMount(), subagent: true },
    tree: replaced(baseTree(), file("/knowledge/a.md", "world\n")),
    notice: "",
    expected: { changes: null, refused: READ_ONLY_TO_SUBAGENT },
  },
  {
    name: "a file added under /mcp is discarded",
    mount: baseMount(),
    tree: [...baseTree(), file("/mcp/0001-read/copy.txt", "kept")],
    notice: MCP,
    expected: unchanged(),
  },
  {
    name: "a write beside the repositories is discarded, a folder is not",
    mount: baseMount(),
    tree: [...baseTree(), dir("/repos"), dir("/repos/new"), file("/repos/new/x", "x")],
    notice: REPOS,
    expected: unchanged(),
  },
  {
    name: "with the docs off a doc written is discarded and nothing read",
    mount: { ...baseMount(), docs: false, knowledge: [], cwd: "/tmp" },
    tree: [
      ...without(baseTree(), "/knowledge/a.md"),
      file("/knowledge/new.md", "x\n"),
    ],
    pwd: "/tmp",
    notice: DOCS_OFF,
    expected: unchanged("/tmp"),
  },
  {
    name: "every discard notice, in order",
    mount: { ...baseMount(), docs: false, knowledge: [], cwd: "/tmp" },
    tree: [
      ...without(baseTree(), "/knowledge/a.md", "/uploads/in/data.csv"),
      file("/knowledge/new.md", "x\n"),
      file("/mcp/extra", "x"),
      dir("/repos"),
      file("/repos/x", "x"),
    ],
    pwd: "/tmp",
    notice: DOCS_OFF + UPLOADS + MCP + REPOS,
    expected: unchanged("/tmp"),
  },
  {
    name: "the cwd moves to a folder that exists, normalized",
    mount: baseMount(),
    tree: [...baseTree(), dir("/tmp/sub")],
    pwd: "/tmp/./x/../sub/",
    notice: "",
    expected: unchanged("/tmp/sub"),
  },
  {
    name: "a cwd that is gone goes home",
    mount: baseMount(),
    tree: baseTree(),
    pwd: "/tmp/gone",
    notice: "",
    expected: unchanged("/knowledge"),
  },
  {
    name: "a cwd outside the trees goes home",
    mount: baseMount(),
    tree: baseTree(),
    pwd: "/",
    notice: "",
    expected: unchanged("/knowledge"),
  },
  {
    name: "a cwd in the docs while they are off waits in /tmp",
    mount: { ...baseMount(), docs: false, knowledge: [], cwd: "/knowledge/x" },
    tree: without(baseTree(), "/knowledge/a.md"),
    pwd: "/tmp",
    notice: "",
    expected: unchanged("/knowledge/x"),
  },
  {
    name: "an exit at a deadline reads nothing back",
    mount: baseMount(),
    tree: [...baseTree(), { path: "/tmp/link", kind: "link", mode: 0o777, target: "/" }],
    exitCode: 124,
    notice: "",
    expected: { changes: null, refused: null },
  },
  {
    name: "an exit at a limit reads nothing back",
    mount: baseMount(),
    tree: replaced(baseTree(), file("/knowledge/a.md", "world\n")),
    exitCode: 126,
    notice: "",
    expected: { changes: null, refused: null },
  },
];
