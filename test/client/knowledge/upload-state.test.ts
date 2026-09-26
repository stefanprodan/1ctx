// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { noticeOf } from "../../../src/client/lib/save.ts";
import {
  UPLOAD_BYTES,
  type UploadPorts,
  UploadState,
} from "../../../src/client/views/knowledge/Upload.state.ts";
import {
  byteProgress,
  FOLDER_HINT,
  itemWords,
  pickedWords,
  progressWords,
  skippedLog,
  uploadTotals,
} from "../../../src/client/views/knowledge/Upload.words.ts";
import type {
  KnowledgeUploadReason,
  KnowledgeUploadResult,
} from "../../../src/shared/contracts/knowledge.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class PickedFile extends File {
  readonly slices: [number | undefined, number | undefined][] = [];
  reads = 0;
  read: (() => Promise<ArrayBuffer>) | null = null;

  constructor(name: string, body: BlobPart = "text", lastModified = 1) {
    super([body], name, { lastModified, type: "application/octet-stream" });
  }

  override slice(start?: number, end?: number, type?: string): Blob {
    this.slices.push([start, end]);
    return super.slice(start, end, type);
  }

  override arrayBuffer(): Promise<ArrayBuffer> {
    this.reads++;
    return this.read ? this.read() : super.arrayBuffer();
  }
}

function result(
  changes: Partial<KnowledgeUploadResult> = {},
): KnowledgeUploadResult {
  return {
    added: 0,
    replaced: 0,
    unchanged: 0,
    renamed: 0,
    saved: [],
    skipped: [],
    skippedTotal: 0,
    ...changes,
  };
}

function refusal(error: string, status: number): Error & { status: number } {
  return Object.assign(new Error(error), { status });
}

type UploadCall = {
  file: File;
  folder: string;
  options: Parameters<UploadPorts["upload"]>[2];
  answer: ReturnType<typeof deferred<KnowledgeUploadResult>>;
};

function setup(
  options: {
    fileBytes?: number;
    names?: string[];
    reload?: () => Promise<void>;
  } = {},
) {
  let user: string | null = "alice";
  let rules = {
    fileBytes: options.fileBytes ?? 1024 * 1024,
    names: options.names ?? [],
  };
  let reloads = 0;
  const calls: UploadCall[] = [];
  const starts = new Map<number, ReturnType<typeof deferred<UploadCall>>>();
  const state = new UploadState({
    currentUser: () => user,
    rules: () => rules,
    upload(file, folder, uploadOptions) {
      const answer = deferred<KnowledgeUploadResult>();
      const call = { file, folder, options: uploadOptions, answer };
      calls.push(call);
      uploadOptions.signal.addEventListener(
        "abort",
        () => answer.reject(new DOMException("Stopped", "AbortError")),
        { once: true },
      );
      starts.get(calls.length - 1)?.resolve(call);
      return answer.promise;
    },
    async reload() {
      reloads++;
      await options.reload?.();
    },
  });
  return {
    state,
    calls,
    get reloads() {
      return reloads;
    },
    setUser(value: string | null) {
      user = value;
    },
    setRules(value: typeof rules) {
      rules = value;
    },
    next(index: number): Promise<UploadCall> {
      if (calls[index]) return Promise.resolve(calls[index]);
      let wait = starts.get(index);
      if (!wait) {
        wait = deferred<UploadCall>();
        starts.set(index, wait);
      }
      return wait.promise;
    },
  };
}

function archive(name = "docs.zip", length = 1024): PickedFile {
  const bytes = new Uint8Array(length);
  bytes.set([0x50, 0x4b, 3, 4]);
  return new PickedFile(name, bytes);
}

function tarHeader(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(512);
  const encoder = new TextEncoder();
  bytes.set(encoder.encode("notes.md"));
  bytes.set(encoder.encode("ustar"), 257);
  bytes.fill(32, 148, 156);
  const sum = bytes.reduce((total, byte) => total + byte, 0);
  bytes.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return bytes;
}

function outcomes(state: UploadState) {
  return state.items.value.map((item) => item.outcome?.type ?? null);
}

describe("upload picks", () => {
  test.serial(
    "starts empty, and an empty run sends and reloads nothing",
    async () => {
      const h = setup();
      expect(h.state.phase.value).toBe("empty");
      expect(h.state.folder.value).toBe("");
      expect(h.state.items.value).toEqual([]);
      expect(h.state.ready).toEqual([]);
      expect(h.state.busy).toBe(false);
      expect(h.state.status.value).toBe("idle");
      expect(h.state.notice()).toBeNull();
      expect(FOLDER_HINT).toBe(
        "The root when empty. Names are saved lowercase with dashes, so My Docs/On Call.md becomes my-docs/on-call.md",
      );
      await h.state.run();
      expect(h.calls).toHaveLength(0);
      expect(h.reloads).toBe(0);
    },
  );

  test.serial(
    "sniffs only the first 512 bytes, independent of the name",
    async () => {
      const fixtures = [
        {
          file: new PickedFile(
            "archive.txt",
            new Uint8Array([80, 75, 3, 4, 0]),
          ),
          kind: "zip",
          words: "zip archive · 5 B",
        },
        {
          file: new PickedFile("empty.data", new Uint8Array([80, 75, 5, 6])),
          kind: "zip",
          words: "zip archive · 4 B",
        },
        {
          file: new PickedFile("gzip.md", new Uint8Array([31, 139, 0])),
          kind: "gzip",
          words: "tar.gz archive · 3 B",
        },
        {
          file: new PickedFile("tar.zip", tarHeader()),
          kind: "tar",
          words: "tar archive · 512 B",
        },
        {
          file: new PickedFile("notes.tar.gz", "PK is ordinary text"),
          kind: "text",
          words: "text file · 19 B",
        },
        {
          file: new PickedFile("notes.zip", "plain"),
          kind: "text",
          words: "text file · 5 B",
        },
      ] as const;
      const h = setup();
      await h.state.pick(fixtures.map(({ file }) => file));
      expect(h.state.phase.value).toBe("picked");
      expect(h.state.ready).toHaveLength(fixtures.length);
      for (const [index, fixture] of fixtures.entries()) {
        const item = h.state.items.value[index];
        expect(item.file).toBe(fixture.file);
        expect(item.kind).toBe(fixture.kind);
        expect(item.outcome).toBeNull();
        expect(pickedWords(item)).toBe(fixture.words);
        expect(fixture.file.slices).toEqual([[0, 512]]);
        expect(fixture.file.reads).toBe(fixture.kind === "text" ? 1 : 0);
      }
    },
  );

  test.serial(
    "ustar in text without a valid header checksum stays text",
    async () => {
      const bytes = new Uint8Array(800).fill(97);
      bytes.set(new TextEncoder().encode("ustar"), 257);
      const file = new PickedFile("not-a-tar.tar", bytes);
      const h = setup();
      await h.state.pick([file]);
      expect(h.state.items.value[0].kind).toBe("text");
      expect(h.state.items.value[0].outcome).toBeNull();
      expect(file.slices).toEqual([[0, 512]]);
      expect(file.reads).toBe(1);
    },
  );

  test.serial(
    "keeps a text file that holds a U+FFFD it was written with",
    async () => {
      // a doc about encodings can hold the character itself; strict
      // decoding already refused every corrupt byte
      const h = setup();
      await h.state.pick([
        new PickedFile("encodings.md", "bad byte: \ufffd\n"),
      ]);
      expect(h.state.items.value[0].outcome).toBeNull();
      expect(h.state.ready).toHaveLength(1);
    },
  );

  test.serial("rejects NUL and bad UTF-8 after byte 512", async () => {
    const malformed = new Uint8Array(900).fill(97);
    malformed[850] = 0xff;
    const files = [
      new PickedFile("nul.txt", `${"a".repeat(800)}\0`),
      new PickedFile("bad-byte.txt", malformed),
    ];
    const h = setup();
    await h.state.pick(files);
    expect(outcomes(h.state)).toEqual(["skipped", "skipped"]);
    for (const item of h.state.items.value) {
      expect(item.outcome).toEqual({ type: "skipped", reason: "not-text" });
      expect(pickedWords(item)).toBe("not text");
    }
    expect(files.map((file) => file.reads)).toEqual([1, 1]);
    expect(h.state.ready).toEqual([]);
    await h.state.run();
    expect(h.calls).toHaveLength(0);
    expect(h.reloads).toBe(0);
    expect(h.state.phase.value).toBe("picked");
    expect(uploadTotals(h.state.items.value)).toEqual({
      added: 0,
      replaced: 0,
      unchanged: 0,
      skipped: 2,
      failed: 0,
      bytes: 0,
      sent: 0,
      files: 0,
    });
  });

  test.serial(
    "accepts complete UTF-8 text, even across the sniff boundary",
    async () => {
      const file = new PickedFile(
        "Café Notes.md",
        `${"a".repeat(511)}é\n日本語\n`,
      );
      const h = setup();
      await h.state.pick([file]);
      const item = h.state.items.value[0];
      expect(item.outcome).toBeNull();
      expect(item.name).toBe("cafe-notes.md");
      expect(pickedWords(item)).toBe(
        `text file · ${file.size} B · saved as cafe-notes.md`,
      );
      expect(file.reads).toBe(1);
    },
  );

  test.serial(
    "rejects over 32 MiB before reading but permits exactly the cap",
    async () => {
      const over = new PickedFile(
        "../large.zip",
        new Uint8Array(UPLOAD_BYTES + 1),
      );
      const edge = archive("edge.txt", UPLOAD_BYTES);
      const h = setup();
      await h.state.pick([over, edge]);
      expect(UPLOAD_BYTES).toBe(32 * 1024 * 1024);
      expect(h.state.items.value[0].outcome).toEqual({
        type: "skipped",
        reason: "upload-size",
      });
      expect(pickedWords(h.state.items.value[0])).toBe(
        "over the 32 MB upload limit",
      );
      expect(over.slices).toEqual([]);
      expect(over.reads).toBe(0);
      expect(h.state.items.value[1].outcome).toBeNull();
      expect(edge.slices).toEqual([[0, 512]]);
      expect(edge.reads).toBe(0);
      expect(h.state.ready.map((item) => item.file)).toEqual([edge]);
    },
  );

  test.serial(
    "judges loose names by the shared rules and leaves macOS metadata out",
    async () => {
      const cases: [string, KnowledgeUploadReason][] = [
        ["../escape.md", "outside"],
        ["日本語", "no-letters"],
        [".-.", "bad-name"],
        ["a".repeat(81), "too-long"],
        ["a/b/c/d/e/f/g/h/i.md", "too-long"],
      ];
      const metadata = [
        "./__MACOSX/notes.md",
        "docs/.DS_Store",
        "docs\\._notes.md",
      ];
      const h = setup();
      await h.state.pick(
        [...cases.map(([name]) => name), ...metadata].map(
          (name) => new PickedFile(name),
        ),
      );
      expect(h.state.items.value.map((item) => item.outcome)).toEqual(
        cases.map(([, reason]) => ({ type: "skipped", reason })),
      );
      expect(h.state.ready).toHaveLength(0);
      await h.state.run();
      expect(h.calls).toHaveLength(0);
      expect(h.state.notice()).toBeNull();
    },
  );

  test.serial("name refusals take precedence over size and text", async () => {
    const cases: [string, KnowledgeUploadReason][] = [
      ["../escape.md", "outside"],
      ["日本語", "no-letters"],
      [".-.", "bad-name"],
      ["a".repeat(81), "too-long"],
    ];
    for (const fileBytes of [1, 10]) {
      const h = setup({ fileBytes });
      await h.state.pick(cases.map(([name]) => new PickedFile(name, "a\0b")));
      expect(h.state.items.value.map((item) => item.outcome)).toEqual(
        cases.map(([, reason]) => ({ type: "skipped", reason })),
      );
      h.state.setFolder("Docs");
      expect(h.state.items.value.map((item) => item.outcome)).toEqual(
        cases.map(([, reason]) => ({ type: "skipped", reason })),
      );
      expect(h.state.ready).toHaveLength(0);
      await h.state.run();
      expect(h.calls).toHaveLength(0);
      expect(h.state.notice()).toBeNull();
    }
  });

  test.serial(
    "over-cap loose files defer their bytes only for normalized live replacements",
    async () => {
      const h = setup({ fileBytes: 2, names: ["my-docs/live.md"] });
      const over = new PickedFile("over.md", "a\0b");
      const live = new PickedFile("Live.md", "a\0b");
      const under = new PickedFile("under.md", "\0");
      for (const file of [over, live]) {
        file.read = async () => {
          throw new Error("an over-cap loose file must not be read whole");
        };
      }
      h.state.setFolder("My Docs");
      await h.state.pick([over, live, under]);
      expect(h.state.items.value.map((item) => item.outcome)).toEqual([
        { type: "skipped", reason: "too-big" },
        null,
        { type: "skipped", reason: "not-text" },
      ]);
      expect(h.state.items.value[1].name).toBe("my-docs/live.md");
      h.state.setFolder("Elsewhere");
      expect(h.state.items.value[1].outcome).toEqual({
        type: "skipped",
        reason: "too-big",
      });
      h.state.setFolder("My Docs");
      expect(h.state.items.value[1].outcome).toBeNull();
      expect(h.state.ready.map((item) => item.file)).toEqual([live]);
      const running = h.state.run();
      const call = await h.next(0);
      expect(call.file).toBe(live);
      expect(call.folder).toBe("My Docs");
      call.answer.resolve(
        result({
          skipped: [{ index: 0, name: "Live.md", reason: "not-text" }],
          skippedTotal: 1,
        }),
      );
      await running;
      expect(outcomes(h.state)).toEqual(["skipped", "unchanged", "skipped"]);
      expect(itemWords(h.state.items.value[1])).toEqual({ note: "skipped" });
      expect(h.calls).toHaveLength(1);
      expect(over.reads).toBe(0);
      expect(live.reads).toBe(0);
      expect(under.reads).toBe(1);
      expect(over.slices).toEqual([[0, 512]]);
      expect(live.slices).toEqual([[0, 512]]);
      expect(h.state.notice()).toBeNull();
    },
  );

  test.serial(
    "leaves an over-cap normalized live replacement to the server",
    async () => {
      const h = setup({
        fileBytes: 2,
        names: ["naive-strasse.md", "README.md"],
      });
      const live = new PickedFile("Naïve Straße.md", "larger");
      const other = new PickedFile("README.md", "larger");
      await h.state.pick([live, other]);
      expect(h.state.items.value[0].name).toBe("naive-strasse.md");
      expect(h.state.items.value[0].outcome).toBeNull();
      expect(h.state.items.value[1].name).toBe("readme.md");
      expect(h.state.items.value[1].outcome).toEqual({
        type: "skipped",
        reason: "too-big",
      });
      const running = h.state.run();
      const call = await h.next(0);
      expect(call.file).toBe(live);
      call.answer.resolve(result({ replaced: 1, saved: ["naive-strasse.md"] }));
      await running;
      expect(outcomes(h.state)).toEqual(["written", "skipped"]);
      expect(h.calls).toHaveLength(1);
    },
  );

  test.serial(
    "folder edits rejudge normalized live names without reading their bodies",
    async () => {
      const h = setup({ fileBytes: 2, names: ["my-docs/on-call.md"] });
      const file = new PickedFile("On Call.md", "larger");
      file.read = async () => {
        throw new Error("an over-cap replacement must not be read whole");
      };
      await h.state.pick([file]);
      expect(h.state.items.value[0].outcome).toEqual({
        type: "skipped",
        reason: "too-big",
      });
      h.state.setFolder("My Docs");
      expect(h.state.folder.value).toBe("My Docs");
      expect(h.state.items.value[0].name).toBe("my-docs/on-call.md");
      expect(h.state.items.value[0].outcome).toBeNull();
      expect(pickedWords(h.state.items.value[0])).toBe(
        "text file · 6 B · saved as my-docs/on-call.md",
      );
      h.state.setFolder("Other Docs");
      expect(h.state.items.value[0].outcome).toEqual({
        type: "skipped",
        reason: "too-big",
      });
      h.state.setFolder("My Docs");
      const running = h.state.run();
      const call = await h.next(0);
      expect(call.folder).toBe("My Docs");
      expect(call.file).toBe(file);
      call.answer.resolve(
        result({ replaced: 1, saved: ["my-docs/on-call.md"] }),
      );
      await running;
      expect(file.reads).toBe(0);
      expect(file.slices).toEqual([[0, 512]]);
    },
  );

  test.serial(
    "a folder can make a valid joined name too deep, then valid again",
    async () => {
      const h = setup();
      const file = new PickedFile("g/h/i.md");
      await h.state.pick([file]);
      h.state.setFolder("a/b/c/d/e/f");
      expect(h.state.items.value[0].outcome).toEqual({
        type: "skipped",
        reason: "too-long",
      });
      h.state.setFolder("a/b/c/d/e");
      expect(h.state.items.value[0].name).toBe("a/b/c/d/e/g/h/i.md");
      expect(h.state.items.value[0].outcome).toBeNull();
      expect(file.reads).toBe(1);
    },
  );

  test.serial(
    "deduplicates by name, size and modification time across picks",
    async () => {
      const h = setup();
      const first = new PickedFile("one.md", "one", 1);
      const duplicate = new PickedFile("one.md", "two", 1);
      const resized = new PickedFile("one.md", "more", 1);
      const modified = new PickedFile("one.md", "one", 2);
      const renamed = new PickedFile("two.md", "one", 1);
      await h.state.pick([first, duplicate]);
      await h.state.pick([first, resized, modified, renamed]);
      expect(h.state.items.value.map((item) => item.file)).toEqual([
        first,
        resized,
        modified,
        renamed,
      ]);
      expect(duplicate.reads).toBe(0);
      expect(duplicate.slices).toEqual([]);
      expect(first.reads).toBe(1);
      h.state.remove(first);
      await h.state.pick([duplicate]);
      expect(h.state.items.value.map((item) => item.file)).toEqual([
        resized,
        modified,
        renamed,
        duplicate,
      ]);
      for (const item of [...h.state.items.value]) h.state.remove(item.file);
      expect(h.state.phase.value).toBe("empty");
      expect(h.state.ready).toEqual([]);
    },
  );

  test.serial(
    "ignores another drop and edits while a pick is being read",
    async () => {
      const h = setup();
      h.state.setFolder("My Docs");
      const read = deferred<ArrayBuffer>();
      const started = deferred<void>();
      const first = new PickedFile("one.md");
      first.read = () => {
        started.resolve();
        return read.promise;
      };
      const picking = h.state.pick([first]);
      await started.promise;
      expect(h.state.busy).toBe(true);
      expect(h.state.reading.value).toBe(true);
      const ignored = new PickedFile("ignored.md");
      await h.state.pick([ignored]);
      h.state.setFolder("changed");
      h.state.remove(first);
      h.state.reset();
      await h.state.run();
      expect(h.calls).toHaveLength(0);
      expect(ignored.slices).toEqual([]);
      expect(ignored.reads).toBe(0);
      expect(h.state.folder.value).toBe("My Docs");
      read.resolve(new TextEncoder().encode("text").buffer);
      await picking;
      expect(h.state.busy).toBe(false);
      expect(h.state.reading.value).toBe(false);
      expect(h.state.items.value.map((item) => item.file)).toEqual([first]);
    },
  );

  test.serial(
    "a failed picked-file read belongs to Foot, not an item or field",
    async () => {
      const h = setup();
      const good = new PickedFile("good.md");
      const bad = new PickedFile("unreadable.md");
      bad.read = async () => {
        throw new Error("the file is no longer available");
      };
      const later = new PickedFile("later.md");
      await h.state.pick([good, bad, later]);
      expect(h.state.notice()).toEqual({
        action: "read the picked file",
        error: "the file is no longer available",
      });
      expect(noticeOf(h.state.notice()!)).toBe(
        "Could not read the picked file. The file is no longer available.",
      );
      expect(h.state.fieldError("folder")).toBeNull();
      expect(h.state.items.value.map((item) => item.file)).toEqual([good]);
      expect(outcomes(h.state)).toEqual([null]);
      expect(later.reads).toBe(0);
      expect(h.state.busy).toBe(false);
      await h.state.pick([later]);
      expect(h.state.notice()).toBeNull();
      expect(h.state.ready).toHaveLength(2);
    },
  );

  test.serial(
    "refuses an invalid folder at its field before starting a run",
    async () => {
      const folders = [
        "../docs",
        "docs\\..\\elsewhere",
        "a/b/c/d/e/f/g/h",
        ["a".repeat(60), "b".repeat(60), "c".repeat(59)].join("/"),
      ];
      for (const folder of folders) {
        const h = setup();
        await h.state.pick([archive()]);
        h.state.setFolder(folder);
        await h.state.run();
        expect(h.state.folder.value).toBe(folder);
        expect(h.state.fieldError("folder")).toContain("Folder");
        expect(h.state.notice()).toBeNull();
        expect(h.state.busy).toBe(false);
        expect(h.state.phase.value).toBe("picked");
        expect(h.calls).toHaveLength(0);
        expect(h.reloads).toBe(0);
        h.state.setFolder("My Docs");
        expect(h.state.fieldError("folder")).toBeNull();
      }
    },
  );

  test.serial(
    "rechecks current file limits before anything is sent",
    async () => {
      const h = setup({ fileBytes: 10 });
      await h.state.pick([new PickedFile("notes.md", "longer")]);
      expect(h.state.ready).toHaveLength(1);
      h.setRules({ fileBytes: 2, names: [] });
      await h.state.run();
      expect(h.state.items.value[0].outcome).toEqual({
        type: "skipped",
        reason: "too-big",
      });
      expect(h.calls).toHaveLength(0);
      expect(h.reloads).toBe(0);
    },
  );
});

describe("upload runs", () => {
  test.serial(
    "sends the original files sequentially, tracking waiting, sending and saving",
    async () => {
      const reloaded = deferred<void>();
      const reloading = deferred<void>();
      const h = setup({
        reload: () => {
          reloading.resolve();
          return reloaded.promise;
        },
      });
      const bad = new PickedFile("bad.bin", "\0");
      const first = new PickedFile("First.md", "a".repeat(1024));
      const second = archive("docs.data", 2048);
      const last = new PickedFile("last.md", "b".repeat(1024));
      h.state.setFolder("My Docs");
      await h.state.pick([bad, first, second, last]);
      const running = h.state.run();
      const one = await h.next(0);
      expect(one.file).toBe(first);
      expect(one.folder).toBe("My Docs");
      expect(h.calls).toHaveLength(1);
      expect(h.state.phase.value).toBe("uploading");
      expect(h.state.busy).toBe(true);
      expect(h.state.items.value.map((item) => item.phase)).toEqual([
        "done",
        "sending",
        "waiting",
        "waiting",
      ]);
      expect(itemWords(h.state.items.value[2])).toEqual({
        note: "waiting",
        running: false,
      });
      one.options.onProgress(512, first.size);
      expect(itemWords(h.state.items.value[1])).toEqual({
        note: "sending, 0.5 of 1 KB",
        running: true,
      });
      expect(uploadTotals(h.state.items.value)).toEqual({
        added: 0,
        replaced: 0,
        unchanged: 0,
        skipped: 1,
        failed: 0,
        bytes: 4096,
        sent: 512,
        files: 3,
      });
      expect(progressWords(h.state)).toEqual({
        title: "Uploading 1 of 3",
        detail: "First.md",
        failed: "",
        aside: "0.5 of 4 KB",
        percent: 12.5,
      });
      one.options.onProgress(1024, first.size);
      expect(itemWords(h.state.items.value[1])).toEqual({
        note: "saving",
        running: true,
      });
      expect(h.calls).toHaveLength(1);
      const ignored = new PickedFile("ignored.md");
      await h.state.pick([ignored]);
      h.state.setFolder("changed");
      h.state.remove(last);
      h.state.reset();
      await h.state.run();
      expect(h.state.items.value).toHaveLength(4);
      expect(h.state.folder.value).toBe("My Docs");
      expect(ignored.reads).toBe(0);
      expect(ignored.slices).toEqual([]);
      one.answer.resolve(
        result({ added: 1, renamed: 1, saved: ["my-docs/first.md"] }),
      );
      const two = await h.next(1);
      expect(two.file).toBe(second);
      expect(two.options.signal).toBe(one.options.signal);
      two.options.onProgress(1024, second.size);
      expect(progressWords(h.state)).toEqual({
        title: "Uploading 2 of 3",
        detail: "docs.data",
        failed: "",
        aside: "2 of 4 KB",
        percent: 50,
      });
      expect(itemWords(h.state.items.value[1])).toEqual({
        note: "added my-docs/first.md",
      });
      two.answer.resolve(
        result({
          added: 30,
          replaced: 12,
          unchanged: 2,
          renamed: 9,
          skipped: [{ index: 0, name: "image.png", reason: "not-text" }],
          skippedTotal: 13,
        }),
      );
      const three = await h.next(2);
      expect(three.file).toBe(last);
      expect(three.folder).toBe("My Docs");
      expect(itemWords(h.state.items.value[2])).toEqual({
        note: "30 added · 12 replaced · 2 unchanged · 13 skipped",
      });
      three.answer.resolve(result({ unchanged: 1 }));
      await reloading.promise;
      expect(h.reloads).toBe(1);
      expect(h.state.busy).toBe(true);
      expect(progressWords(h.state).title).toBe("Finishing");
      reloaded.resolve();
      await running;
      expect(h.calls).toHaveLength(3);
      expect(h.state.busy).toBe(false);
      expect(h.state.stopped.value).toBe(false);
      expect(h.state.phase.value).toBe("done");
      expect(outcomes(h.state)).toEqual([
        "skipped",
        "written",
        "written",
        "unchanged",
      ]);
      expect(uploadTotals(h.state.items.value)).toEqual({
        added: 31,
        replaced: 12,
        unchanged: 3,
        skipped: 14,
        failed: 0,
        bytes: 4096,
        sent: 4096,
        files: 3,
      });
      expect(progressWords(h.state)).toEqual({
        title: "Saved 43 files",
        detail: "31 added, 12 replaced, 3 unchanged",
        failed: "",
        aside: "14 skipped",
        percent: 100,
      });
      expect(first.reads).toBe(1);
      expect(last.reads).toBe(1);
      expect(second.reads).toBe(0);
      await h.state.pick([ignored]);
      h.state.remove(first);
      expect(h.state.items.value).toHaveLength(4);
      h.state.reset();
      expect(h.state.phase.value).toBe("empty");
      expect(h.state.folder.value).toBe("My Docs");
      expect(h.state.items.value).toEqual([]);
      expect(h.state.stopped.value).toBe(false);
      await h.state.pick([ignored]);
      expect(h.state.phase.value).toBe("picked");
      expect(h.state.ready).toHaveLength(1);
    },
  );

  test.serial(
    "an archive item's refusal stays on its line and the run goes on",
    async () => {
      const h = setup();
      const zip = archive("first.zip");
      await h.state.pick([zip, new PickedFile("next.md")]);
      const running = h.state.run();
      const first = await h.next(0);
      expect(first.file).toBe(zip);
      first.answer.reject(
        refusal("notes.md changed while uploading, try again", 409),
      );
      const second = await h.next(1);
      expect(h.state.notice()).toBeNull();
      expect(h.state.fieldError("folder")).toBeNull();
      expect(itemWords(h.state.items.value[0])).toEqual({
        note: "notes.md changed while uploading, try again",
        bad: true,
        status: 409,
      });
      second.answer.resolve(result({ added: 1, saved: ["next.md"] }));
      await running;
      expect(outcomes(h.state)).toEqual(["failed", "written"]);
      expect(h.state.stopped.value).toBe(false);
      expect(h.reloads).toBe(1);
      expect(progressWords(h.state)).toMatchObject({
        title: "Saved 1 file",
        detail: "1 added",
        failed: "1 upload failed",
        percent: 100,
      });
    },
  );

  test.serial(
    "a conflict on a file named folder is an item failure, not a field refusal",
    async () => {
      const h = setup({ names: ["folder"] });
      const file = new PickedFile("folder");
      await h.state.pick([file, new PickedFile("next.md")]);
      const running = h.state.run();
      const first = await h.next(0);
      expect(first.file).toBe(file);
      first.answer.reject(
        refusal("folder changed while uploading, try again", 409),
      );
      const second = await h.next(1);
      expect(itemWords(h.state.items.value[0])).toEqual({
        note: "folder changed while uploading, try again",
        bad: true,
        status: 409,
      });
      expect(h.state.fieldError("folder")).toBeNull();
      expect(h.state.folderRefused.value).toBe(false);
      expect(h.state.notice()).toBeNull();
      expect(second.options.signal.aborted).toBe(false);
      second.answer.resolve(result({ added: 1, saved: ["next.md"] }));
      await running;
      expect(h.calls).toHaveLength(2);
      expect(outcomes(h.state)).toEqual(["failed", "written"]);
      expect(h.state.stopped.value).toBe(false);
      expect(h.reloads).toBe(1);
      expect(progressWords(h.state)).toMatchObject({
        title: "Saved 1 file",
        detail: "1 added",
        failed: "1 upload failed",
        percent: 100,
      });
    },
  );

  test.serial(
    "a network failure goes on, then a folder refusal stops at its field",
    async () => {
      const h = setup();
      await h.state.pick([
        archive("offline.zip"),
        archive("folder.zip"),
        archive("not-sent.zip"),
      ]);
      const running = h.state.run();
      const first = await h.next(0);
      first.answer.reject(new Error("Could not reach the server"));
      const second = await h.next(1);
      expect(itemWords(h.state.items.value[0])).toEqual({
        note: "Could not reach the server",
        bad: true,
        status: undefined,
      });
      second.answer.reject(refusal("folder must be given at most once", 400));
      await running;
      expect(h.calls).toHaveLength(2);
      expect(outcomes(h.state)).toEqual(["failed", "failed", "not-sent"]);
      expect(h.state.stopped.value).toBe(true);
      expect(h.state.fieldError("folder")).toBe(
        "Folder must be given at most once.",
      );
      expect(h.state.status.value).toMatchObject({
        field: "folder",
        status: 400,
      });
      expect(h.state.folderRefused.value).toBe(true);
      expect(h.state.notice()).toBeNull();
      expect(itemWords(h.state.items.value[1])).toEqual({ note: "not saved" });
      expect(itemWords(h.state.items.value[2])).toEqual({ note: "not sent" });
      expect(progressWords(h.state).failed).toBe("2 uploads failed");
      expect(h.reloads).toBe(1);
      h.state.setFolder("Other Docs");
      expect(h.state.folder.value).toBe("Other Docs");
      expect(h.state.fieldError("folder")).toBeNull();
      expect(h.state.folderRefused.value).toBe(true);
      expect(outcomes(h.state)).toEqual(["failed", "failed", "not-sent"]);
      expect(progressWords(h.state).failed).toBe("2 uploads failed");
      h.state.reset();
      expect(h.state.folder.value).toBe("Other Docs");
      expect(h.state.status.value).toBe("idle");
      expect(h.state.stopped.value).toBe(false);
      expect(h.state.folderRefused.value).toBe(false);
    },
  );

  test.serial(
    "a 401 in the middle keeps prior results and sends nothing more",
    async () => {
      const h = setup();
      await h.state.pick([
        new PickedFile("saved.md"),
        new PickedFile("expired.md"),
        new PickedFile("later.md"),
      ]);
      const running = h.state.run();
      const first = await h.next(0);
      first.answer.resolve(result({ added: 1, saved: ["saved.md"] }));
      const second = await h.next(1);
      second.answer.reject(refusal("sign in to continue", 401));
      await running;
      expect(h.calls).toHaveLength(2);
      expect(second.options.signal.aborted).toBe(true);
      expect(outcomes(h.state)).toEqual(["written", "failed", "not-sent"]);
      expect(itemWords(h.state.items.value[1])).toEqual({
        note: "sign in to continue",
        bad: true,
        status: 401,
      });
      expect(h.state.stopped.value).toBe(true);
      expect(uploadTotals(h.state.items.value).added).toBe(1);
    },
  );

  test.serial(
    "a 401 that signs out never reloads the former user's project",
    async () => {
      const h = setup();
      await h.state.pick([
        new PickedFile("first.md"),
        new PickedFile("next.md"),
      ]);
      const running = h.state.run();
      const call = await h.next(0);
      call.answer.reject(refusal("sign in to continue", 401));
      h.setUser(null);
      h.state.userChanged();
      await running;
      expect(outcomes(h.state)).toEqual(["failed", "not-sent"]);
      expect(h.calls).toHaveLength(1);
      expect(h.reloads).toBe(0);
    },
  );

  test.serial(
    "a user change aborts in flight, and never advances or reloads",
    async () => {
      const h = setup();
      await h.state.pick([
        new PickedFile("first.md"),
        new PickedFile("next.md"),
      ]);
      const running = h.state.run();
      const call = await h.next(0);
      h.state.userChanged();
      expect(call.options.signal.aborted).toBe(false);
      call.options.onProgress(1, call.file.size);
      h.setUser("bob");
      h.state.userChanged();
      expect(call.options.signal.aborted).toBe(true);
      await running;
      expect(h.calls).toHaveLength(1);
      expect(h.reloads).toBe(0);
      expect(outcomes(h.state)).toEqual(["not-sent", "not-sent"]);
      await h.state.pick([new PickedFile("bob.md")]);
      h.state.reset();
      await h.state.run();
      expect(h.calls).toHaveLength(1);
    },
  );

  test.serial(
    "a changed user is checked again between two uploads",
    async () => {
      const h = setup();
      await h.state.pick([
        new PickedFile("first.md"),
        new PickedFile("next.md"),
      ]);
      const running = h.state.run();
      const call = await h.next(0);
      h.setUser("bob");
      call.answer.resolve(result({ added: 1, saved: ["first.md"] }));
      await running;
      expect(outcomes(h.state)).toEqual(["written", "not-sent"]);
      expect(h.calls).toHaveLength(1);
      expect(h.reloads).toBe(0);
      expect(call.options.signal.aborted).toBe(true);
    },
  );

  test.serial(
    "a changed user before the run prevents the first send",
    async () => {
      const h = setup();
      await h.state.pick([new PickedFile("first.md")]);
      h.setUser("bob");
      await h.state.run();
      expect(h.calls).toHaveLength(0);
      expect(h.reloads).toBe(0);
    },
  );

  test.serial(
    "unmount aborts the current request and never starts the next",
    async () => {
      const h = setup();
      await h.state.pick([
        new PickedFile("first.md"),
        new PickedFile("next.md"),
      ]);
      const running = h.state.run();
      const call = await h.next(0);
      call.options.onProgress(call.file.size, call.file.size);
      h.state.dispose();
      expect(call.options.signal.aborted).toBe(true);
      await running;
      expect(h.calls).toHaveLength(1);
      expect(outcomes(h.state)).toEqual(["uncertain", "not-sent"]);
      expect(h.state.stopped.value).toBe(true);
      expect(h.reloads).toBe(1);
    },
  );

  test.serial(
    "unmount or a changed user during a read never adopts its file",
    async () => {
      for (const why of ["unmount", "user"] as const) {
        const h = setup();
        const read = deferred<ArrayBuffer>();
        const started = deferred<void>();
        const file = new PickedFile("reading.md");
        file.read = () => {
          started.resolve();
          return read.promise;
        };
        const picking = h.state.pick([file, new PickedFile("next.md")]);
        await started.promise;
        if (why === "unmount") h.state.dispose();
        else h.setUser("bob");
        read.resolve(new TextEncoder().encode("text").buffer);
        await picking;
        expect(h.state.items.value).toEqual([]);
        expect(h.state.busy).toBe(false);
        await h.state.run();
        expect(h.calls).toHaveLength(0);
        expect(h.reloads).toBe(0);
      }
    },
  );

  test.serial(
    "Stop before the body finishes marks it and the queue not sent",
    async () => {
      for (const sent of [0, 2]) {
        const h = setup();
        await h.state.pick([
          new PickedFile("first.md"),
          new PickedFile("next.md"),
        ]);
        const running = h.state.run();
        const call = await h.next(0);
        call.options.onProgress(sent, call.file.size);
        h.state.stop();
        expect(call.options.signal.aborted).toBe(true);
        call.options.onProgress(call.file.size, call.file.size);
        await running;
        expect(h.calls).toHaveLength(1);
        expect(outcomes(h.state)).toEqual(["not-sent", "not-sent"]);
        expect(h.state.items.value[0].sent).toBe(sent);
        expect(itemWords(h.state.items.value[0])).toEqual({ note: "not sent" });
        expect(h.state.stopped.value).toBe(true);
        expect(progressWords(h.state)).toMatchObject({
          title: "Nothing saved",
          detail: "",
          failed: "",
          percent: 100,
        });
        expect(h.reloads).toBe(1);
      }
    },
  );

  test.serial(
    "all six disjoint outcomes keep only confirmed writes in totals",
    async () => {
      const h = setup();
      const files = [
        new PickedFile("added.md"),
        new PickedFile("same.md"),
        new PickedFile("binary.bin", "\0"),
        new PickedFile("failed.md"),
        archive("stopped.zip"),
        new PickedFile("waiting.md"),
      ];
      await h.state.pick(files);
      const running = h.state.run();
      const first = await h.next(0);
      first.answer.resolve(result({ added: 1, saved: ["added.md"] }));
      const second = await h.next(1);
      second.answer.resolve(result({ unchanged: 1 }));
      const third = await h.next(2);
      third.answer.reject(refusal("the server is busy, try again", 503));
      const fourth = await h.next(3);
      fourth.options.onProgress(fourth.file.size, fourth.file.size);
      expect(h.state.items.value[4].phase).toBe("saving");
      h.state.stop();
      await running;
      expect(outcomes(h.state)).toEqual([
        "written",
        "unchanged",
        "skipped",
        "failed",
        "uncertain",
        "not-sent",
      ]);
      expect(itemWords(h.state.items.value[1])).toEqual({ note: "unchanged" });
      expect(itemWords(h.state.items.value[4])).toEqual({
        note: "stopped, may have saved",
      });
      expect(uploadTotals(h.state.items.value)).toMatchObject({
        added: 1,
        replaced: 0,
        unchanged: 1,
        skipped: 1,
        failed: 1,
        files: 5,
        bytes: 1040,
        sent: 1032,
      });
      expect(progressWords(h.state)).toEqual({
        title: "Saved 1 file",
        detail: "1 added, 1 unchanged",
        failed: "1 upload failed",
        aside: "1 skipped",
        percent: 100,
      });
      expect(h.state.stopped.value).toBe(true);
      expect(h.reloads).toBe(1);
      expect(h.calls).toHaveLength(4);
    },
  );

  test.serial(
    "a zero-write run distinguishes unchanged, skipped and empty answers",
    async () => {
      const h = setup();
      await h.state.pick([
        new PickedFile("same.md"),
        new PickedFile("skipped.md"),
        archive("empty.zip"),
        archive("skipped.zip"),
      ]);
      const running = h.state.run();
      const first = await h.next(0);
      first.answer.resolve(result({ unchanged: 1 }));
      const second = await h.next(1);
      second.answer.resolve(
        result({
          skipped: [{ index: 0, name: "skipped.md", reason: "clash-live" }],
          skippedTotal: 1,
        }),
      );
      const third = await h.next(2);
      third.answer.resolve(result());
      const fourth = await h.next(3);
      fourth.answer.resolve(
        result({
          unchanged: 2,
          skipped: [{ index: 0, name: "image.png", reason: "not-text" }],
          skippedTotal: 1,
        }),
      );
      await running;
      expect(outcomes(h.state)).toEqual([
        "unchanged",
        "unchanged",
        "unchanged",
        "unchanged",
      ]);
      expect(h.state.items.value.map((item) => itemWords(item).note)).toEqual([
        "unchanged",
        "skipped",
        "no files",
        "2 unchanged · 1 skipped",
      ]);
      expect(uploadTotals(h.state.items.value)).toMatchObject({
        added: 0,
        replaced: 0,
        unchanged: 3,
        skipped: 2,
        failed: 0,
      });
      expect(progressWords(h.state)).toEqual({
        title: "Nothing saved",
        detail: "3 unchanged",
        failed: "",
        aside: "2 skipped",
        percent: 100,
      });
      expect(h.state.stopped.value).toBe(false);
      expect(h.reloads).toBe(1);
    },
  );

  test.serial(
    "a loose replacement uses the server's saved name on its line",
    async () => {
      const h = setup();
      await h.state.pick([new PickedFile("On Call.md")]);
      const running = h.state.run();
      const call = await h.next(0);
      call.answer.resolve(result({ replaced: 1, saved: ["on-call.md"] }));
      await running;
      expect(itemWords(h.state.items.value[0])).toEqual({
        note: "replaced on-call.md",
      });
      expect(progressWords(h.state)).toMatchObject({
        title: "Saved 1 file",
        detail: "1 replaced",
      });
    },
  );

  test.serial(
    "a reload failure does not lose an upload's confirmed outcome",
    async () => {
      const h = setup({
        reload: async () => {
          throw refusal("the project list is unavailable", 503);
        },
      });
      await h.state.pick([new PickedFile("saved.md")]);
      const running = h.state.run();
      const call = await h.next(0);
      call.answer.resolve(result({ added: 1, saved: ["saved.md"] }));
      await running;
      expect(outcomes(h.state)).toEqual(["written"]);
      expect(h.state.phase.value).toBe("done");
      expect(h.state.busy).toBe(false);
      expect(h.state.notice()).toEqual({
        action: "reload the files",
        error: "the project list is unavailable",
        status: 503,
      });
      expect(uploadTotals(h.state.items.value).failed).toBe(0);
      expect(h.reloads).toBe(1);
    },
  );
});

describe("upload logs", () => {
  test("byte progress uses one shared unit, including empty files", () => {
    expect(byteProgress(0, 0)).toBe("0 of 0 B");
    expect(byteProgress(3, 8)).toBe("3 of 8 B");
    expect(byteProgress(512 * 1024, 812 * 1024)).toBe("512 of 812 KB");
    expect(byteProgress(4.6 * 1024 * 1024, 4.9 * 1024 * 1024)).toBe(
      "4.6 of 4.9 MB",
    );
  });

  test.serial(
    "cuts the combined skipped log at ten and opens all groups",
    async () => {
      const h = setup();
      await h.state.pick([
        new PickedFile("bad.bin", "\0"),
        archive("first.zip"),
        archive("second.zip"),
        new PickedFile("other.bin", "\0"),
      ]);
      const running = h.state.run();
      const first = await h.next(0);
      first.answer.resolve(
        result({
          skipped: Array.from({ length: 7 }, (_, index) => ({
            index,
            name: `first-${index}.png`,
            reason: "not-text",
          })),
          skippedTotal: 7,
        }),
      );
      const second = await h.next(1);
      second.answer.resolve(
        result({
          added: 1,
          saved: ["valid.md"],
          skipped: Array.from({ length: 5 }, (_, index) => ({
            index,
            name: `second-${index}.png`,
            reason: "not-text",
          })),
          skippedTotal: 5,
        }),
      );
      await running;
      const cut = skippedLog(h.state.items.value, false);
      expect(cut.total).toBe(14);
      expect(cut.groups.map((group) => group.name)).toEqual([
        "first.zip",
        "second.zip",
      ]);
      expect(cut.groups.map((group) => group.lines.length)).toEqual([7, 3]);
      expect(cut.groups.flatMap((group) => group.lines)).toHaveLength(10);
      expect(cut.groups.every((group) => group.more === null)).toBe(true);
      const all = skippedLog(h.state.items.value, true);
      expect(all.total).toBe(14);
      expect(all.groups.map((group) => group.name)).toEqual([
        "first.zip",
        "second.zip",
        "Picked",
      ]);
      expect(all.groups.map((group) => group.lines.length)).toEqual([7, 5, 2]);
      expect(all.groups[2].lines).toEqual([
        { name: "bad.bin", note: "not text" },
        { name: "other.bin", note: "not text" },
      ]);
    },
  );

  test.serial(
    "the server's 200 names and extra count are preserved, never invented",
    async () => {
      const h = setup();
      await h.state.pick([archive("platform-docs.zip")]);
      const running = h.state.run();
      const call = await h.next(0);
      const skips = Array.from({ length: 200 }, (_, index) => ({
        index,
        name: index === 0 ? "<img src=x onerror=alert(1)>" : `binary-${index}`,
        reason: "not-text" as const,
      }));
      call.answer.resolve(result({ skipped: skips, skippedTotal: 212 }));
      await running;
      const cut = skippedLog(h.state.items.value, false);
      expect(cut.total).toBe(212);
      expect(cut.groups).toHaveLength(1);
      expect(cut.groups[0].lines).toHaveLength(10);
      const all = skippedLog(h.state.items.value, true);
      expect(all.total).toBe(212);
      expect(all.groups[0].lines).toHaveLength(200);
      expect(all.groups[0].lines[0]).toEqual({
        name: "<img src=x onerror=alert(1)>",
        note: "not text",
      });
      expect(all.groups[0].more).toBe("and 12 more in platform-docs.zip");
      expect(itemWords(h.state.items.value[0])).toEqual({
        note: "212 skipped",
      });
      expect(progressWords(h.state).aside).toBe("212 skipped");
    },
  );
});
