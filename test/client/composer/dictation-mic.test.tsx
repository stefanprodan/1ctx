// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composer's mic shows only while Dictation is on and the browser can
// record; the transcription call sends the clip as audio/wav and a 404
// takes the mic away.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Composer } from "../../../src/client/composer/Composer.tsx";
import { transcribe } from "../../../src/client/data/dictation.ts";
import { dictationOn, me } from "../../../src/client/data/me.ts";
import { clientFetch } from "../../helpers/client-fetch.ts";

const GLOBALS = ["isSecureContext", "navigator", "AudioWorkletNode"] as const;
const saved = new Map(
  GLOBALS.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
);

function browser(over: {
  isSecureContext?: boolean;
  getUserMedia?: boolean;
  worklet?: boolean;
}) {
  const set = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { configurable: true, value });
  set("isSecureContext", over.isSecureContext ?? true);
  set("navigator", {
    mediaDevices: over.getUserMedia === false ? {} : { getUserMedia() {} },
  });
  set("AudioWorkletNode", over.worklet === false ? undefined : class {});
}

function restore() {
  for (const [name, descriptor] of saved) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
}

const drawn = () =>
  render(
    <Composer
      scope={{ sessionId: "s1" }}
      filesProjectId="p1"
      agents={null}
      agentId="a1"
      running={false}
      busy={false}
      onSend={async () => {}}
      onStop={async () => {}}
    />,
  );

describe("the composer's mic", () => {
  beforeEach(() => {
    me.value = {
      id: "u1",
      username: "admin",
      fullName: "Admin",
      role: "admin",
      mustChangePassword: false,
    };
  });
  afterEach(() => {
    restore();
    me.value = undefined;
    dictationOn.value = false;
  });

  test.serial(
    "beside Send while Dictation is on and the browser records",
    () => {
      browser({});
      dictationOn.value = true;
      const html = drawn();
      expect(html).toMatch(
        /class="composer-send composer-mic" aria-label="Dictate"[\s\S]*aria-label="Send"/,
      );
      // the input line is there, not the recording strip
      expect(html).toContain('name="message"');
      expect(html).not.toContain('class="dictation"');
    },
  );

  test.serial("hidden while Dictation is off", () => {
    browser({});
    dictationOn.value = false;
    expect(drawn()).not.toContain('aria-label="Dictate"');
  });

  test.serial("hidden without a secure context", () => {
    browser({ isSecureContext: false });
    dictationOn.value = true;
    expect(drawn()).not.toContain('aria-label="Dictate"');
  });

  test.serial("hidden without getUserMedia", () => {
    browser({ getUserMedia: false });
    dictationOn.value = true;
    expect(drawn()).not.toContain('aria-label="Dictate"');
  });

  test.serial("hidden without an AudioWorklet", () => {
    browser({ worklet: false });
    dictationOn.value = true;
    expect(drawn()).not.toContain('aria-label="Dictate"');
  });
});

describe("the transcription call", () => {
  let answer = () => Response.json({ text: "hello there" });
  const calls = clientFetch(() => answer());

  afterEach(() => {
    dictationOn.value = false;
    answer = () => Response.json({ text: "hello there" });
  });

  test.serial("posts the clip as audio/wav and answers its words", async () => {
    const wav = Uint8Array.from([1, 2, 3]);
    expect(await transcribe(wav)).toBe("hello there");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/transcribe");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("audio/wav");
    const body = calls[0]!.init?.body as Blob;
    expect([...new Uint8Array(await body.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  test.serial(
    "a 404 says Dictation went off and takes the mic away",
    async () => {
      dictationOn.value = true;
      answer = () =>
        Response.json({ error: "Dictation is off" }, { status: 404 });
      let status: unknown;
      try {
        await transcribe(new Uint8Array(0));
      } catch (err) {
        status = (err as { status?: number }).status;
      }
      expect(status).toBe(404);
      expect(dictationOn.value).toBe(false);
    },
  );

  test.serial("another refusal keeps the mic", async () => {
    dictationOn.value = true;
    answer = () => Response.json({ error: "busy" }, { status: 409 });
    let status: unknown;
    try {
      await transcribe(new Uint8Array(0));
    } catch (err) {
      status = (err as { status?: number }).status;
    }
    expect(status).toBe(409);
    expect(dictationOn.value).toBe(true);
  });
});
