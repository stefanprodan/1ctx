// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { KNOWLEDGE_COMMANDS } from "../../../src/server/knowledge/limits.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import {
  afterMountRead,
  callCaps,
  freshSignal,
  run,
  type Setup,
  setup,
} from "./helpers.ts";

const create = (s: Setup, name: string, text: string) =>
  s.area.create(s.projectId, s.author, name, text);

describe("knowledge command mounts", () => {
  test("yq edits a multi-document manifest in place, every document kept", async () => {
    const s = setup();
    try {
      const manifest = create(
        s,
        "deploy/app.yaml",
        "kind: ConfigMap\nmetadata:\n  name: a\n---\nkind: Service\nmetadata:\n  name: b\n",
      );
      const result = await run(
        s,
        `yq -i '.metadata.labels.team = "web"' deploy/app.yaml && yq '.metadata.labels.team' deploy/app.yaml`,
      );
      expect(result.error).toBe(false);
      expect(result.content).toContain("web\n---\nweb");
      const text = s.area.read(s.projectId, manifest.id)?.text ?? "";
      expect(text.split("\n---\n")).toHaveLength(2);
    } finally {
      s.db.close();
    }
  });

  test("ls and recursive grep see only the project's rows", async () => {
    const s = setup();
    try {
      create(s, "docs/x.md", "first\nneedle\n");
      const result = await run(s, "ls docs; grep -rn needle .");
      expect(result.error).toBe(false);
      expect(result.content).toContain("x.md");
      expect(result.content).toContain("docs/x.md:2:needle");
      expect(result.content).toEndWith("exit 0");
    } finally {
      s.db.close();
    }
  });

  test("sed, raw heredocs, deletes and moves each keep attributed versions", async () => {
    const s = setup();
    try {
      const first = create(s, "docs/x.md", "old\n");
      const edited = await run(s, "sed -i 's/old/new/' docs/x.md");
      expect(edited).toEqual({
        error: false,
        content: "exit 0\nwrote docs/x.md (rev 2, 1 lines)",
        opened: [],
        tail: "exit 0\nwrote docs/x.md (rev 2, 1 lines)".length,
      });
      expect(s.area.read(s.projectId, first.id)).toMatchObject({
        text: "new\n",
        author: s.agent,
        revision: 2,
      });
      const version = s.area.versions(s.projectId, first.id)[0]!;
      expect(s.area.version(s.projectId, version.id)).toMatchObject({
        text: "new\n",
        author: s.agent,
        revision: 2,
      });
      const heredoc = await run(
        s,
        "cat > values.yaml <<'EOF'\n  key:\n    value: true\nEOF",
      );
      expect(heredoc.error).toBe(false);
      expect(s.area.store.byName(s.projectId, "values.yaml")?.text).toBe(
        "  key:\n    value: true\n",
      );
      const moved = await run(s, "mv docs/x.md docs/y.md");
      expect(moved.content).toContain("wrote docs/y.md (rev 1, 1 lines)");
      expect(moved.content).toContain("deleted docs/x.md");
      expect(s.area.store.byName(s.projectId, "docs/y.md")?.id).not.toBe(
        first.id,
      );
      expect(s.area.versions(s.projectId, first.id)[0]).toMatchObject({
        deleted: true,
        revision: 3,
        author: s.agent,
      });
      const removed = await run(s, "rm docs/y.md");
      expect(removed).toEqual({
        error: false,
        content: "exit 0\ndeleted docs/y.md",
        opened: [],
        tail: "exit 0\ndeleted docs/y.md".length,
      });
      expect(s.area.list(s.projectId).deleted).toHaveLength(2);
    } finally {
      s.db.close();
    }
  });

  test("mv over a live destination changes it and deletes the source", async () => {
    const s = setup();
    try {
      const source = create(s, "source", "new");
      const target = create(s, "target", "old");
      expect((await run(s, "mv source target")).error).toBe(false);
      expect(s.area.read(s.projectId, target.id)).toMatchObject({
        text: "new",
        revision: 2,
      });
      expect(s.area.versions(s.projectId, source.id)[0]?.deleted).toBe(true);
    } finally {
      s.db.close();
    }
  });

  test.serial(
    "byte-equal writes and directory-only changes publish nothing",
    async () => {
      const s = setup();
      const file = create(s, "x", "same\n");
      const events: BusEvent[] = [];
      const off = subscribe((event) => {
        if (
          event.type === "knowledge.changed" &&
          event.data.projectId === s.projectId
        )
          events.push(event);
      }, silent);
      try {
        expect(
          await run(s, "echo same > x; mkdir empty; rmdir empty; mkdir stays"),
        ).toEqual({ error: false, content: "exit 0", opened: [], tail: 6 });
        expect(events).toEqual([]);
        expect(s.area.versions(s.projectId, file.id)).toHaveLength(1);
        expect(s.area.list(s.projectId).files).toHaveLength(1);
      } finally {
        off();
        s.db.close();
      }
    },
  );

  test.each([
    ["name", "echo bad > 'bad name'", "name must be"],
    ["NUL", "printf AA== | base64 -d > bad", "not a text file"],
    ["invalid UTF-8", "printf wyg= | base64 -d > bad", "not a text file"],
    ["symlink", "ln -s good link", "not a regular file"],
    ["directory symlink", "ln -s /tmp dir", "not a regular file"],
    [
      "root symlink",
      "cd /; rm -r knowledge; ln -s /tmp knowledge",
      "not a regular file",
    ],
    [
      "root file",
      "cd /; rm -r knowledge; echo bad > knowledge",
      "name must be",
    ],
  ])("a %s fails the whole command", async (_name, command, words) => {
    const s = setup();
    try {
      create(s, "existing", "kept");
      const before = s.area.list(s.projectId);
      const result = await run(s, `echo good > good; ${command}`);
      expect(result.error).toBe(true);
      expect(result.content).toContain(words);
      expect(s.area.list(s.projectId)).toEqual(before);
    } finally {
      s.db.close();
    }
  });

  test("a BOM is removed and CRLF and Unicode survive byte read-back", async () => {
    const s = setup();
    try {
      const result = await run(
        s,
        "printf 77u/aGVsbG8NCg== | base64 -d > bom; printf '\u00e9\ud83d\ude00\\n' > unicode; cat unicode",
      );
      expect(result.error).toBe(false);
      expect(result.content).toStartWith("\u00e9\ud83d\ude00\n");
      expect(s.area.store.byName(s.projectId, "bom")?.text).toBe("hello\r\n");
      expect(s.area.store.byName(s.projectId, "unicode")?.text).toBe(
        "\u00e9\ud83d\ude00\n",
      );
    } finally {
      s.db.close();
    }
  });

  test("files outside both trees are discarded, directories are not rows", async () => {
    const s = setup();
    try {
      expect(
        (
          await run(
            s,
            "echo x > /outside; mkdir -p /tmp; echo z > /tmp/z; mkdir empty; echo saved > inside",
          )
        ).error,
      ).toBe(false);
      expect(s.area.list(s.projectId).files.map((file) => file.name)).toEqual([
        "inside",
      ]);
      expect((await run(s, "cat /outside")).error).toBe(true);
      expect((await run(s, "cat /tmp/z")).content).toStartWith("z\n");
    } finally {
      s.db.close();
    }
  });

  test("the registered commands are pinned, with no host or optional runtimes", async () => {
    const s = setup();
    try {
      const registered = await run(s, "ls /bin", {
        ...callCaps,
        resultCut: 5000,
      });
      expect(registered.error).toBe(false);
      const words = registered.content
        .slice(0, registered.content.lastIndexOf("exit 0"))
        .trim()
        .split(/\s+/)
        .sort();
      expect(words).toEqual([...KNOWLEDGE_COMMANDS, "open"].sort());
      for (const command of [
        "curl",
        "wget",
        "node",
        "python3",
        "sqlite3",
        "js-exec",
      ]) {
        const result = await run(s, command);
        expect(result.error).toBe(true);
        expect(result.content).toContain("exit 127");
      }
      expect((await run(s, "cat /etc/passwd")).error).toBe(true);
      expect((await run(s, "eval 'cat /etc/passwd'")).error).toBe(true);
      expect((await run(s, "eval 'node -v'")).error).toBe(true);
      expect(await run(s, "export PRIVATE=not-returned; test 1 = 1")).toEqual({
        error: false,
        content: "exit 0",
        opened: [],
        tail: 6,
      });
    } finally {
      s.db.close();
    }
  });

  test("source budgets and pre-aborted signals discard partial writes", async () => {
    const s = setup();
    try {
      expect(
        (await run(s, `echo discarded > x;\n#${"x".repeat(65_536)}`)).error,
      ).toBe(true);
      expect(s.area.list(s.projectId).files).toEqual([]);
      expect(
        (
          await run(
            s,
            "echo no > x",
            callCaps,
            AbortSignal.abort("already stopped"),
          )
        ).error,
      ).toBe(true);
      expect(s.area.list(s.projectId).files).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test.each([
    ["file bytes", { knowledgeFileBytes: 4 }, "cp s d", "limit is 4"],
    ["project bytes", { knowledgeProjectBytes: 7 }, "cp s extra", "limit is 7"],
    ["file count", { knowledgeFiles: 1 }, "touch extra", "limit is 1"],
  ])(
    "%s refuses all changes with the numbers",
    async (_name, caps, command, words) => {
      const s = setup();
      try {
        create(s, "s", "12345");
        Object.assign(s.caps, caps);
        const result = await run(s, command);
        expect(result.error).toBe(true);
        expect(result.content).toContain(words);
        expect(s.area.list(s.projectId).files.map((file) => file.name)).toEqual(
          ["s"],
        );
      } finally {
        s.db.close();
      }
    },
  );

  test("a full mount throws, leaving no empty or partial database files", async () => {
    const s = setup({
      knowledgeProjectBytes: 1024 * 1024,
      scratchBytes: 1024 * 1024,
      uploadBytes: 1024 * 1024,
    });
    try {
      create(s, "source", "x\n".repeat(64 * 1024));
      const result = await run(
        s,
        "for i in {1..40}; do cp source file$i; done; cat source > last",
        { ...callCaps, resultCut: 500_000 },
      );
      expect(result.error).toBe(true);
      expect(result.content).toContain("ENOSPC");
      expect(s.area.list(s.projectId).files.map((file) => file.name)).toEqual([
        "source",
      ]);
    } finally {
      s.db.close();
    }
  });

  test.each(["replace", "recreate", "create", "delete"] as const)(
    "a racing %s fails by identity, revision or absence",
    async (race) => {
      const s = setup();
      try {
        const file =
          race === "create" ? null : create(s, "docs/x.md", "original");
        afterMountRead(s, () => {
          if (race === "replace")
            s.area.store.replace(file!, s.author, "racing", 101);
          if (race === "recreate" || race === "delete") {
            s.area.store.remove(file!, s.author, 101);
          }
          if (race === "recreate" || race === "create")
            create(s, "docs/x.md", "racing");
        });
        const result = await run(
          s,
          "mkdir -p docs; echo edit > docs/x.md; echo partial > second",
        );
        expect(result.error).toBe(true);
        expect(result.content).toContain(
          "docs/x.md changed while the command ran, read it again",
        );
        expect(s.area.store.byName(s.projectId, "second")).toBeNull();
        expect(s.area.store.byName(s.projectId, "docs/x.md")?.text).toBe(
          race === "delete" ? undefined : "racing",
        );
      } finally {
        s.db.close();
      }
    },
  );

  test("a racing prefix and current totals are checked in the transaction", async () => {
    const s = setup();
    try {
      create(s, "docs-", "");
      afterMountRead(s, () => create(s, "docs/x", ""));
      expect((await run(s, "echo new > docs")).content).toContain(
        "conflicts with file",
      );
      expect(s.area.store.byName(s.projectId, "docs")).toBeNull();
      s.caps.knowledgeFiles = 3;
      afterMountRead(s, () => create(s, "third", ""));
      expect((await run(s, "echo new > fourth")).content).toContain(
        "4 files, the limit is 3",
      );
      expect(s.area.store.byName(s.projectId, "fourth")).toBeNull();
    } finally {
      s.db.close();
    }
  });

  test("a lowered cap allows delete-only commands and smaller writes", async () => {
    const s = setup({ knowledgeFileBytes: 4 * 1024 * 1024 });
    try {
      const file = create(s, "x", "a\n".repeat(1.5 * 1024 * 1024));
      s.caps.knowledgeProjectBytes = 1;
      s.caps.knowledgeFiles = 0;
      expect((await run(s, "printf short > x")).error).toBe(false);
      expect(s.area.read(s.projectId, file.id).text).toBe("short");
      expect((await run(s, "rm x")).error).toBe(false);
    } finally {
      s.db.close();
    }
  });

  test.serial(
    "only four mounts run process-wide; queued commands time out or wait",
    async () => {
      const first = setup();
      const second = setup();
      const controllers = Array.from(
        { length: 4 },
        () => new AbortController(),
      );
      const pending = controllers.map((controller, i) =>
        run(
          first,
          `echo x > file${i}; sleep 1`,
          callCaps,
          controller.signal,
          first.makeSession().id,
        ),
      );
      try {
        await Bun.sleep(30);
        let finished = false;
        const fifth = run(second, "echo queued > queued").then((result) => {
          finished = true;
          return result;
        });
        const expired = await run(
          second,
          "echo no > expired",
          { ...callCaps, callTimeoutMs: 20 },
          freshSignal(),
          second.makeSession().id,
        );
        expect(expired.error).toBe(true);
        expect(finished).toBe(false);
        expect(second.area.list(second.projectId).files).toEqual([]);
        controllers[0]!.abort("free the slot");
        expect((await fifth).error).toBe(false);
        expect(second.area.store.byName(second.projectId, "queued")?.text).toBe(
          "queued\n",
        );
      } finally {
        for (const controller of controllers) controller.abort("done");
        await Promise.all(pending);
        first.db.close();
        second.db.close();
      }
    },
  );
});
