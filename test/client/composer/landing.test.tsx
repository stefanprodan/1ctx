// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Where a transcribed clip lands: the box showing its draft now, a
// composer mounted again included, else the stored draft; an empty
// transcript or a refusal says so there and changes nothing; and only
// the composer of the clip's chat spins.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Composer } from "../../../src/client/composer/Composer.tsx";
import {
  MIN_SAMPLES,
  NO_WORDS,
} from "../../../src/client/composer/dictation.ts";
import { draftKey, readDraft } from "../../../src/client/composer/draft.ts";
import {
  landFailure,
  landWords,
  markTranscribing,
  type Shown,
  showDraft,
  transcribing,
} from "../../../src/client/composer/landing.ts";
import { sendClip } from "../../../src/client/composer/recorder.ts";
import { ApiError } from "../../../src/client/data/api.ts";
import { dictationOn, me } from "../../../src/client/data/me.ts";
import { deferred } from "../../helpers/async.ts";

const KEY = "draft:u1:chat:s1";
const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let rows: Map<string, string>;

beforeEach(() => {
  rows = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => rows.set(key, value),
      removeItem: (key: string) => rows.delete(key),
    },
  });
});

afterEach(() => {
  if (realStorage === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
  } else {
    Object.defineProperty(globalThis, "localStorage", realStorage);
  }
  transcribing.value = new Set();
});

// a box as useDictation registers it, over its own text
function box(text: string) {
  const got = { text, failure: null as string | null, inserts: 0 };
  const shown: Shown = {
    insert: (tap, words) => {
      got.inserts++;
      got.text = `${got.text.slice(0, tap.cursor)}${words}${got.text.slice(tap.cursor)}`;
    },
    fail: (line) => {
      got.failure = line;
    },
  };
  return { got, shown };
}

const tap = { text: "", cursor: 0 };

describe("where the words land", () => {
  test.serial("a composer mounted again takes them, not the old one", () => {
    const first = box("");
    const releaseFirst = showDraft(KEY, first.shown);
    // the user leaves the chat and comes back while the clip is out
    releaseFirst();
    const second = box("");
    const releaseSecond = showDraft(KEY, second.shown);
    landWords(KEY, tap, "hello");
    expect(first.got.inserts).toBe(0);
    expect(second.got.text).toBe("hello");
    // the box wrote the stored draft itself; nothing wrote it behind it
    expect(rows.has(KEY)).toBe(false);
    releaseSecond();
  });

  test.serial(
    "an old box letting go never takes the key from a new one",
    () => {
      const first = box("");
      const releaseFirst = showDraft(KEY, first.shown);
      const second = box("");
      const releaseSecond = showDraft(KEY, second.shown);
      releaseFirst();
      landWords(KEY, tap, "hi");
      expect(second.got.text).toBe("hi");
      releaseSecond();
    },
  );

  test.serial("no box on the key: the stored draft takes them", () => {
    rows.set(KEY, JSON.stringify({ text: "Ask", uploads: [] }));
    landWords(KEY, { text: "Ask", cursor: 3 }, "about it");
    expect(readDraft(KEY).text).toBe("Ask about it");
  });

  test.serial("a failure is said only where the chat is on screen", () => {
    landFailure(KEY, "Dictation: transcription failed");
    const shown = box("keep");
    const release = showDraft(KEY, shown.shown);
    landFailure(KEY, "Dictation: transcription failed");
    expect(shown.got.failure).toBe("Dictation: transcription failed");
    expect(shown.got.text).toBe("keep");
    release();
  });
});

describe("a clip sent", () => {
  test.serial(
    "an empty transcript says no words, the draft untouched",
    async () => {
      const shown = box("keep this");
      const release = showDraft(KEY, shown.shown);
      await sendClip(KEY, tap, [new Int16Array(MIN_SAMPLES)], async () => "  ");
      expect(shown.got.failure).toBe(NO_WORDS);
      expect(shown.got.inserts).toBe(0);
      expect(shown.got.text).toBe("keep this");
      release();
    },
  );

  test.serial("spins its own chat while out, then lands", async () => {
    const shown = box("");
    const release = showDraft(KEY, shown.shown);
    const answer = deferred<string>();
    let sent: Uint8Array | null = null;
    const out = sendClip(KEY, tap, [new Int16Array(4)], (wav) => {
      sent = wav;
      return answer.promise;
    });
    expect(transcribing.value.has(KEY)).toBe(true);
    expect(transcribing.value.has("draft:u1:chat:s2")).toBe(false);
    answer.resolve("words");
    await out;
    expect(sent!.length).toBe(44 + 8);
    expect(transcribing.value.has(KEY)).toBe(false);
    expect(shown.got.text).toBe("words");
    release();
  });

  test.serial("a refusal is its line", async () => {
    const shown = box("");
    const release = showDraft(KEY, shown.shown);
    await sendClip(KEY, tap, [new Int16Array(4)], async () => {
      throw new ApiError(429, "too many");
    });
    expect(shown.got.failure).toBe("Dictation: too many clips, try later");
    expect(transcribing.value.size).toBe(0);
    release();
  });
});

describe("the mic's spinner", () => {
  const GLOBALS = ["isSecureContext", "navigator", "AudioWorkletNode"];
  const saved = GLOBALS.map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  beforeEach(() => {
    for (const [name, value] of [
      ["isSecureContext", true],
      ["navigator", { mediaDevices: { getUserMedia() {} } }],
      ["AudioWorkletNode", class {}],
    ] as const) {
      Object.defineProperty(globalThis, name, { configurable: true, value });
    }
    me.value = {
      id: "u1",
      username: "admin",
      fullName: "Admin",
      role: "admin",
      mustChangePassword: false,
    };
    dictationOn.value = true;
  });
  afterEach(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
    }
    me.value = undefined;
    dictationOn.value = false;
  });

  const drawn = (sessionId: string) =>
    render(
      <Composer
        scope={{ sessionId }}
        filesProjectId="p1"
        agents={null}
        agentId="a1"
        running={false}
        busy={false}
        onSend={async () => {}}
        onStop={async () => {}}
      />,
    );

  test.serial("spins only in the chat the clip started in", () => {
    markTranscribing(draftKey("u1", { sessionId: "s1" }), true);
    expect(drawn("s1")).toContain('aria-label="Transcribing"');
    const other = drawn("s2");
    expect(other).toContain('aria-label="Dictate"');
    expect(other).not.toContain("Transcribing");
  });
});
