// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the composer's Send and Enter carry: images alone go, a draft
// waits on its uploads and checks, and the ids go in the order added.

import { describe, expect, test } from "bun:test";
import {
  type ImagePorts,
  ImageState,
} from "../../../src/client/composer/Images.state.ts";
import { outgoing } from "../../../src/client/composer/outgoing.ts";
import { uploadLine } from "../../../src/client/data/upload-line.ts";
import type { StagedImage } from "../../../src/shared/api/images.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

const NONE = { ids: [], busy: false };
const base = {
  text: "",
  files: NONE,
  images: NONE,
  ready: true,
  placed: true,
  carries: true,
};

const image = (id: string): StagedImage => ({
  id,
  name: `${id}.png`,
  mediaType: "image/png",
  bytes: 10,
  width: 4,
  height: 3,
  expiresAt: 1000,
});

// an image state whose uploads and checks answer when told
function images(saved: { projectId: string; id: string; name: string }[] = []) {
  const answers: ReturnType<typeof deferred<StagedImage>>[] = [];
  const checks: ReturnType<typeof deferred<boolean | null>>[] = [];
  const ports: ImagePorts = {
    stage: () => {
      const answer = deferred<StagedImage>();
      answers.push(answer);
      return answer.promise;
    },
    remove: async () => {},
    check: () => {
      const answer = deferred<boolean | null>();
      checks.push(answer);
      return answer.promise;
    },
    wait: async () => {},
    currentUser: () => "u1",
    save: () => {},
  };
  const state = new ImageState(ports, saved);
  state.show("p1");
  return { state, answers, checks };
}

describe("a send", () => {
  test("of images with an empty text goes, a blank text alone never", () => {
    expect(outgoing(base)).toBeNull();
    expect(outgoing({ ...base, text: "  " })).toBeNull();
    expect(
      outgoing({ ...base, images: { ids: ["im1"], busy: false } }),
    ).toEqual({ uploads: [], images: ["im1"] });
  });

  test("waits while an image uploads, carrying its ids in the order added", async () => {
    const h = images();
    h.state.add([new File(["a"], "b.png"), new File(["a"], "a.png")]);
    await settle();
    const now = () => outgoing({ ...base, text: "look", images: h.state });
    expect(now()).toBeNull();
    h.answers[0]!.resolve(image("im2"));
    await settle();
    expect(now()).toBeNull();
    h.answers[1]!.resolve(image("im1"));
    await settle();
    expect(now()).toEqual({ uploads: [], images: ["im2", "im1"] });
  });

  test("waits while a draft's image is checked", async () => {
    const h = images([{ projectId: "p1", id: "im1", name: "a.png" }]);
    const now = () => outgoing({ ...base, images: h.state });
    expect(now()).toBeNull();
    h.checks[0]!.resolve(true);
    await settle();
    expect(now()).toEqual({ uploads: [], images: ["im1"] });
  });

  test("waits on files too, before its items are known, and while busy", () => {
    const shot = { ids: ["im1"], busy: false };
    expect(
      outgoing({ ...base, images: shot, files: { ids: [], busy: true } }),
    ).toBeNull();
    expect(outgoing({ ...base, images: shot, placed: false })).toBeNull();
    expect(outgoing({ ...base, images: shot, ready: false })).toBeNull();
  });

  test("a command carries no items and waits on none", () => {
    expect(
      outgoing({
        ...base,
        text: "/compact",
        carries: false,
        images: { ids: ["im1"], busy: true },
      }),
    ).toEqual({ uploads: [], images: [] });
  });
});

describe("the upload line", () => {
  test("a mixed pick runs a file and an image one after the other", async () => {
    const line = uploadLine();
    const started: string[] = [];
    const file = deferred<string>();
    const shot = deferred<string>();
    const first = line(() => {
      started.push("file");
      return file.promise;
    });
    const second = line(() => {
      started.push("image");
      return shot.promise;
    });
    await settle();
    expect(started).toEqual(["file"]);
    // a refusal settles it as well as an answer does
    file.reject(new Error("too large"));
    await expect(first).rejects.toThrow("too large");
    await settle();
    expect(started).toEqual(["file", "image"]);
    shot.resolve("im1");
    expect(await second).toBe("im1");
  });

  test("one let go while it waits leaves at once and never starts", async () => {
    const line = uploadLine();
    const started: string[] = [];
    const held = deferred<string>();
    void line(() => {
      started.push("first");
      return held.promise;
    });
    const controller = new AbortController();
    const waiting = line(async () => {
      started.push("second");
      return "x";
    }, controller.signal);
    controller.abort();
    const error = await waiting.then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as DOMException).name).toBe("AbortError");
    held.resolve("done");
    await settle();
    expect(started).toEqual(["first"]);
    // the line goes on behind it
    expect(await line(async () => "third")).toBe("third");
  });
});
