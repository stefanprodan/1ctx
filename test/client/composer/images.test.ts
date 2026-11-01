// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { DraftImage } from "../../../src/client/composer/draft.ts";
import {
  IMAGE_ACCEPT,
  routeFiles,
} from "../../../src/client/composer/Images.model.ts";
import {
  type ImagePorts,
  ImageState,
} from "../../../src/client/composer/Images.state.ts";
import type { StagedImage } from "../../../src/shared/api/images.ts";
import { CHANNEL_NO_IMAGES } from "../../../src/shared/images.ts";
import { UPLOAD_RUNNING } from "../../../src/shared/uploads.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const file = (name: string, type = "", body = "0123456789") =>
  new File([body], name, { type });

const image = (id: string, name = "shot.png"): StagedImage => ({
  id,
  name,
  mediaType: "image/png",
  bytes: 10,
  width: 40,
  height: 30,
  expiresAt: 1000,
});

const refusal = (words: string, status: number) =>
  Object.assign(new Error(words), { status });

type Call = {
  projectId: string;
  file: File;
  signal: AbortSignal;
  progress: (sent: number, total: number) => void;
  answer: ReturnType<typeof deferred<StagedImage>>;
};

function harness(saved: DraftImage[] = []) {
  const calls: Call[] = [];
  const removed: string[] = [];
  const checks: [string, ReturnType<typeof deferred<boolean | null>>][] = [];
  const saves: DraftImage[][] = [];
  const waits: ReturnType<typeof deferred<void>>[] = [];
  let user: string | null = "u1";
  const ports: ImagePorts = {
    stage: (projectId, picked, options) => {
      const answer = deferred<StagedImage>();
      calls.push({
        projectId,
        file: picked,
        signal: options.signal,
        progress: options.onProgress,
        answer,
      });
      options.signal.addEventListener("abort", () =>
        answer.reject(new DOMException("aborted", "AbortError")),
      );
      return answer.promise;
    },
    remove: async (_projectId, id) => {
      removed.push(id);
    },
    check: (_projectId, id) => {
      const answer = deferred<boolean | null>();
      checks.push([id, answer]);
      return answer.promise;
    },
    wait: () => {
      const gate = deferred<void>();
      waits.push(gate);
      return gate.promise;
    },
    currentUser: () => user,
    save: (images) => {
      saves.push(images);
    },
  };
  const state = new ImageState(ports, saved);
  return {
    state,
    calls,
    removed,
    checks,
    saves,
    waits,
    signOut: () => {
      user = null;
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

const phases = (state: ImageState) =>
  state.shown.map((item) => [item.name, item.phase]);

describe("where a file goes", () => {
  test("a JPEG, PNG, WebP or GIF goes as an image, any other file as an upload", () => {
    const picked = [
      file("a.jpg", "image/jpeg"),
      file("b.png", "image/png"),
      file("c.webp", "image/webp"),
      file("d.gif", "image/gif"),
      file("e.svg", "image/svg+xml"),
      file("f.heic", "image/heic"),
      file("notes.md", "text/markdown"),
      file("bare"),
    ];
    const routed = routeFiles(picked, { channel: false });
    expect(routed.images.map((f) => f.name)).toEqual([
      "a.jpg",
      "b.png",
      "c.webp",
      "d.gif",
    ]);
    expect(routed.uploads.map((f) => f.name)).toEqual([
      "e.svg",
      "f.heic",
      "notes.md",
      "bare",
    ]);
    expect(routed.refusal).toBeNull();
  });

  test("the Add images picker sends every file it gives as an image, so the server says why", () => {
    const routed = routeFiles([file("e.svg", "image/svg+xml"), file("x.txt")], {
      channel: false,
      images: true,
    });
    expect(routed.images).toHaveLength(2);
    expect(routed.uploads).toHaveLength(0);
    expect(IMAGE_ACCEPT).toBe("image/jpeg,image/png,image/webp,image/gif");
  });

  test("a channel refuses images before an upload and keeps its files", () => {
    const routed = routeFiles(
      [file("a.png", "image/png"), file("notes.md", "text/markdown")],
      { channel: true },
    );
    expect(routed.images).toHaveLength(0);
    expect(routed.uploads.map((f) => f.name)).toEqual(["notes.md"]);
    expect(routed.refusal).toBe(CHANNEL_NO_IMAGES);
  });
});

describe("staging images", () => {
  test("uploads one at a time with progress, keeps the ids in order in the draft, and Send waits", async () => {
    const h = harness();
    h.state.show("p1");
    h.state.add([file("one.png"), file("two.png")]);
    await settle();
    expect(phases(h.state)).toEqual([
      ["one.png", "sending"],
      ["two.png", "waiting"],
    ]);
    expect(h.state.busy).toBe(true);
    h.calls[0]!.progress(5, 10);
    expect(h.state.shown[0]!.sent).toBe(5);
    h.calls[0]!.answer.resolve(image("im1", "one.png"));
    await settle();
    expect(h.calls).toHaveLength(2);
    h.calls[1]!.answer.resolve(image("im2", "two.png"));
    await settle();
    expect(h.state.busy).toBe(false);
    expect(h.state.ids).toEqual(["im1", "im2"]);
    expect(h.saves.at(-1)).toEqual([
      { projectId: "p1", id: "im1", name: "one.png" },
      { projectId: "p1", id: "im2", name: "two.png" },
    ]);
  });

  test("a refusal keeps the server's words and status, and blocks nothing", async () => {
    const h = harness();
    h.state.show("p1");
    h.state.add([file("big.png"), file("ok.png")]);
    await settle();
    h.calls[0]!.answer.reject(refusal("the image is over 20 MiB", 413));
    await settle();
    h.calls[1]!.answer.resolve(image("im2", "ok.png"));
    await settle();
    expect(h.state.shown[0]).toMatchObject({
      phase: "refused",
      words: "the image is over 20 MiB",
      status: 413,
    });
    expect(h.state.busy).toBe(false);
    expect(h.state.ids).toEqual(["im2"]);
  });

  test("an upload of a file running waits and tries again", async () => {
    const h = harness();
    h.state.show("p1");
    h.state.add([file("one.png")]);
    await settle();
    h.calls[0]!.answer.reject(refusal(UPLOAD_RUNNING, 409));
    await settle();
    expect(phases(h.state)).toEqual([["one.png", "waiting"]]);
    h.waits[0]!.resolve();
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(phases(h.state)).toEqual([["one.png", "sending"]]);
  });

  test("a staged image removed is deleted on the server", async () => {
    const h = harness();
    h.state.show("p1");
    h.state.add([file("one.png")]);
    await settle();
    h.calls[0]!.answer.resolve(image("im1"));
    await settle();
    h.state.remove(h.state.shown[0]!.key);
    expect(h.removed).toEqual(["im1"]);
    expect(h.state.shown).toHaveLength(0);
    expect(h.saves.at(-1)).toEqual([]);
  });

  test("one let go while its bytes still go is stopped, nothing to delete", async () => {
    const h = harness();
    h.state.show("p1");
    h.state.add([file("one.png")]);
    await settle();
    h.calls[0]!.progress(4, 10);
    h.state.remove(h.state.shown[0]!.key);
    await settle();
    expect(h.calls[0]!.signal.aborted).toBe(true);
    expect(h.removed).toEqual([]);
  });

  test("one let go after its bytes all went finishes and is deleted later", async () => {
    const h = harness();
    h.state.show("p1");
    h.state.add([file("one.png")]);
    await settle();
    h.calls[0]!.progress(10, 10);
    h.state.remove(h.state.shown[0]!.key);
    expect(h.calls[0]!.signal.aborted).toBe(false);
    h.calls[0]!.answer.resolve(image("im1"));
    await settle();
    expect(h.removed).toEqual(["im1"]);
  });

  test("an unmount lets go the same way", async () => {
    const h = harness();
    h.state.show("p1");
    h.state.add([file("one.png")]);
    await settle();
    h.calls[0]!.progress(10, 10);
    h.state.dispose();
    h.calls[0]!.answer.resolve(image("im1"));
    await settle();
    expect(h.removed).toEqual(["im1"]);
  });

  test("a send takes its images and their refusals out of the draft", async () => {
    const h = harness();
    h.state.show("p1");
    h.state.add([file("one.png"), file("bad.png")]);
    await settle();
    h.calls[0]!.answer.resolve(image("im1"));
    await settle();
    h.calls[1]!.answer.reject(refusal("not an image this server takes", 400));
    await settle();
    h.state.sent(["im1"]);
    expect(h.state.shown).toHaveLength(0);
    expect(h.removed).toEqual([]);
  });

  test("another project's images are put away and come back with it", async () => {
    const h = harness();
    h.state.show("p1");
    h.state.add([file("one.png")]);
    await settle();
    h.calls[0]!.answer.resolve(image("im1"));
    await settle();
    h.state.show("p2");
    expect(h.state.shown).toHaveLength(0);
    expect(h.state.ids).toEqual([]);
    h.state.show("p1");
    expect(h.state.ids).toEqual(["im1"]);
  });
});

describe("a draft's images", () => {
  const saved = [
    { projectId: "p1", id: "im1", name: "kept.png" },
    { projectId: "p1", id: "im2", name: "stale.png" },
    { projectId: "p1", id: "im3", name: "unsure.png" },
  ];

  test("are checked before Send goes, and a stale one drops without a word", async () => {
    const h = harness(saved);
    h.state.show("p1");
    expect(phases(h.state)).toEqual([
      ["kept.png", "checking"],
      ["stale.png", "checking"],
      ["unsure.png", "checking"],
    ]);
    expect(h.state.busy).toBe(true);
    expect(h.checks.map(([id]) => id)).toEqual(["im1", "im2", "im3"]);
    h.checks[0]![1].resolve(true);
    h.checks[1]![1].resolve(false);
    h.checks[2]![1].resolve(null);
    await settle();
    expect(h.state.busy).toBe(false);
    expect(h.state.ids).toEqual(["im1", "im3"]);
    expect(h.state.shown.some((item) => item.phase === "refused")).toBe(false);
    expect(h.saves.at(-1)?.map((s) => s.id)).toEqual(["im1", "im3"]);
  });

  test("a send refused for a gone image drops them all, the staged ones deleted", async () => {
    const h = harness(saved.slice(0, 2));
    h.state.show("p1");
    // a sent image's bytes still answer, so the check keeps it
    h.checks[0]![1].resolve(true);
    h.checks[1]![1].resolve(true);
    await settle();
    h.state.add([file("new.png")]);
    await settle();
    h.state.gone();
    expect(h.state.ids).toEqual([]);
    expect(phases(h.state)).toEqual([["new.png", "sending"]]);
    expect(h.removed).toEqual(["im1", "im2"]);
    expect(h.saves.at(-1)).toEqual([]);
  });

  test("a check that lands after a sign-out changes nothing", async () => {
    const h = harness([saved[0]!]);
    h.state.show("p1");
    h.signOut();
    h.checks[0]![1].resolve(false);
    await settle();
    expect(phases(h.state)).toEqual([["kept.png", "checking"]]);
  });
});
