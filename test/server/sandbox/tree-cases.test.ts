// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shared tree fixtures through the sandbox backend: the case's rows
// pushed, its tree left by the command, the walk and pull read back by
// the same rules, the answer as the builtin shell's.

import { describe, expect, test } from "bun:test";
import { TREE_CASES } from "../../fixtures/bash/tree-cases.ts";
import { ROOT_PATHS } from "../../helpers/sandbox-fs.ts";
import { answerOf, type Rows, setup } from "./backend-helpers.ts";

const decode = (data: Uint8Array) => new TextDecoder().decode(data);

// trees a sandbox cannot be left with: the walk lists a path once, a
// root is a mount point, and /repos is read-only and never walked
const SKIPPED = new Set([
  "a path listed twice refuses the save",
  "an upload listed without bytes reads as changed",
  "/tmp removed refuses the save",
  "/tmp a file refuses the save",
]);
const REPOS =
  "changes under /repos were discarded: copy a file to /tmp to change it\n";

describe("the tree fixtures through the sandbox", () => {
  for (const item of TREE_CASES.filter((each) => !SKIPPED.has(each.name))) {
    test(item.name, async () => {
      const t = setup();
      const { mount } = item;
      const rows: Rows = {
        docs: mount.docs,
        cwd: mount.cwd,
        knowledge: Object.fromEntries(
          mount.knowledge.map((file) => [file.name, decode(file.data)]),
        ),
        scratch: Object.fromEntries(
          mount.scratch.map((file) => [
            file.name,
            { text: decode(file.data), mode: file.mode },
          ]),
        ),
        uploads: Object.fromEntries(
          mount.uploads.map((file) => [file.name, decode(file.data)]),
        ),
        kept: Object.fromEntries(mount.kept.map((path) => [path, "kept"])),
        ...(mount.subagent ? { subagent: true } : {}),
      };
      const ran = await t.run(rows, ({ fs }) => {
        for (const path of [...fs.nodes.keys()])
          if (ROOT_PATHS.some((root) => path.startsWith(`${root}/`)))
            fs.nodes.delete(path);
        const sorted = [...item.tree].sort((a, b) =>
          a.path < b.path ? -1 : 1,
        );
        for (const entry of sorted) {
          if (
            ROOT_PATHS.includes(entry.path) ||
            entry.path.startsWith("/repos")
          )
            continue;
          if (entry.kind === "dir")
            fs.nodes.set(entry.path, {
              kind: "dir",
              mode: entry.mode,
              mtime: 0,
            });
          else if (entry.kind === "file")
            fs.write(entry.path, entry.text ?? "", entry.mode);
          else if (entry.kind === "link")
            fs.nodes.set(entry.path, {
              kind: "link",
              target: entry.target ?? "/",
            });
          else fs.nodes.set(entry.path, { kind: "other", mode: entry.mode });
        }
        return { exit: item.exitCode ?? 0, pwd: item.pwd ?? mount.cwd };
      });
      const answer = answerOf(ran.settled);
      expect(answer.notice).toBe(item.notice.replace(REPOS, ""));
      if ("refusedContains" in item.expected) {
        expect(answer.changes).toBeNull();
        expect(answer.refused).toContain(item.expected.refusedContains);
      } else {
        expect({ changes: answer.changes, refused: answer.refused }).toEqual(
          item.expected,
        );
      }
      ran.settle({ landed: false, why: "skipped" });
    });
  }
});
