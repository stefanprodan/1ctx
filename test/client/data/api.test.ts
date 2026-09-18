// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One call to the server: the server's own words pass through as the
// error, and an answer without them, a crash page or no answer at all,
// gets plain words for its status, never the status code.

import { afterEach, describe, expect, test } from "bun:test";
import {
  ApiError,
  api,
  statusWords,
  upload,
} from "../../../src/client/data/api.ts";
import { me, setMe } from "../../../src/client/data/me.ts";

const realFetch = globalThis.fetch;
const realXhr = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
const initialMe = me.value;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realXhr) Object.defineProperty(globalThis, "XMLHttpRequest", realXhr);
  else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
  me.value = initialMe;
});

function answer(response: () => Response): void {
  globalThis.fetch = (async () => response()) as unknown as typeof fetch;
}

async function refusal(call = api("/api/tools")): Promise<ApiError> {
  try {
    await call;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("the call went through");
}

class FakeXhr {
  method = "";
  path = "";
  async = false;
  withCredentials = false;
  headers = new Headers();
  body: Blob | null = null;
  status = 0;
  responseText = "";
  aborted = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  upload: {
    onprogress:
      | ((event: {
          loaded: number;
          total: number;
          lengthComputable: boolean;
        }) => void)
      | null;
  } = { onprogress: null };

  open(method: string, path: string, async: boolean): void {
    this.method = method;
    this.path = path;
    this.async = async;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  send(body: Blob): void {
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  respond(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

function fakeXhr(): FakeXhr {
  const xhr = new FakeXhr();
  function Request() {
    return xhr;
  }
  Object.defineProperty(globalThis, "XMLHttpRequest", {
    configurable: true,
    value: Request,
  });
  return xhr;
}

function signIn(): void {
  setMe({
    id: "user",
    username: "admin",
    fullName: "Administrator",
    role: "admin",
    mustChangePassword: false,
  });
}

describe("api", () => {
  test.serial("the server's own words are the error", async () => {
    answer(() => Response.json({ error: "email is taken" }, { status: 409 }));
    const err = await refusal();
    expect(err.status).toBe(409);
    expect(err.message).toBe("email is taken");
  });

  test.serial("a crash page never shows its status code", async () => {
    answer(() => new Response("<html>boom</html>", { status: 500 }));
    const err = await refusal();
    expect(err.status).toBe(500);
    expect(err.message).not.toContain("500");
    expect(err.message).toBe(statusWords(500));
  });

  test.serial("no answer at all is status 0 with its words", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const err = await refusal();
    expect(err.status).toBe(0);
    expect(err.message).toBe("the server did not answer");
  });

  test.serial("a 401 drops the signed-in user", async () => {
    signIn();
    answer(() => Response.json({ error: "sign in" }, { status: 401 }));
    expect(await refusal()).toMatchObject({ status: 401, message: "sign in" });
    expect(me.value).toBeNull();
  });

  test.serial(
    "an error body without an object uses the status words",
    async () => {
      for (const body of [null, [], "wrong", { error: " " }, { error: 123 }]) {
        answer(() => Response.json(body, { status: 400 }));
        expect(await refusal()).toMatchObject({
          status: 400,
          message: statusWords(400),
        });
      }
    },
  );

  test.serial("every status has words without a number in them", () => {
    for (const status of [0, 400, 403, 404, 405, 413, 429, 500, 502, 503]) {
      expect(statusWords(status)).not.toMatch(/\d/);
    }
  });
});

describe("upload", () => {
  test.serial(
    "POSTs the Blob unchanged and parses the JSON answer",
    async () => {
      const xhr = fakeXhr();
      const bytes = new Uint8Array([0x50, 0x4b, 0, 0x80, 0xff]);
      const body = new Blob([bytes], { type: "application/zip" });
      const result = upload<{ saved: number }>("/api/test-upload", body, {});
      expect(xhr.method).toBe("POST");
      expect(xhr.path).toBe("/api/test-upload");
      expect(xhr.async).toBe(true);
      // XHR includes same-origin cookies by default, like fetch in api().
      expect(xhr.withCredentials).toBe(false);
      expect(xhr.headers.get("content-type")).toBe("application/octet-stream");
      expect(xhr.body).toBe(body);
      expect(new Uint8Array(await xhr.body!.arrayBuffer())).toEqual(bytes);
      xhr.respond(201, '{"saved":2}');
      expect(await result).toEqual({ saved: 2 });
    },
  );

  test.serial("reports bytes sent and total from upload progress", async () => {
    const xhr = fakeXhr();
    const progress: number[][] = [];
    const result = upload("/api/test-upload", new Blob(["bytes"]), {
      onProgress: (sent, total) => progress.push([sent, total]),
    });
    for (const loaded of [2, 5]) {
      xhr.upload.onprogress?.({ loaded, total: 5, lengthComputable: true });
    }
    expect(progress).toEqual([
      [2, 5],
      [5, 5],
    ]);
    xhr.respond(200, "{}");
    await result;
  });

  test.serial(
    "a signal aborts the request with a distinguishable error",
    async () => {
      const xhr = fakeXhr();
      const stop = new AbortController();
      const result = upload("/api/test-upload", new Blob(), {
        signal: stop.signal,
      });
      stop.abort(new Error("stopped by caller"));
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(xhr.aborted).toBe(true);
    },
  );

  test.serial("an already aborted signal sends nothing", async () => {
    const xhr = fakeXhr();
    await expect(
      upload("/api/test-upload", new Blob(), { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(xhr.body).toBeNull();
  });

  test.serial("a late abort cannot abort a completed request", async () => {
    const xhr = fakeXhr();
    const stop = new AbortController();
    const result = upload("/api/test-upload", new Blob(), {
      signal: stop.signal,
    });
    xhr.respond(200, "{}");
    await result;
    stop.abort();
    expect(xhr.aborted).toBe(false);
  });

  test.serial("failures share api's words and status", async () => {
    for (const [status, body, message] of [
      [409, '{"error":"an upload is running"}', "an upload is running"],
      [413, "", statusWords(413)],
      [502, "<html>bad gateway</html>", statusWords(502)],
      [400, '{"error":" "}', statusWords(400)],
      [400, "null", statusWords(400)],
    ] as const) {
      const xhr = fakeXhr();
      const result = refusal(upload("/api/test-upload", new Blob(), {}));
      xhr.respond(status, body);
      expect(await result).toMatchObject({ status, message });
      answer(() => new Response(body, { status }));
      expect(await refusal()).toMatchObject({ status, message });
    }
  });

  test.serial(
    "network failures and timeouts have status 0 and its words",
    async () => {
      for (const event of ["onerror", "ontimeout"] as const) {
        const xhr = fakeXhr();
        const result = refusal(upload("/api/test-upload", new Blob(), {}));
        xhr[event]?.();
        expect(await result).toMatchObject({
          status: 0,
          message: "the server did not answer",
        });
      }
    },
  );

  test.serial(
    "a 401 drops the user with or without JSON error words",
    async () => {
      for (const body of ['{"error":"sign in"}', ""]) {
        signIn();
        const xhr = fakeXhr();
        const stop = new AbortController();
        // Signing out can itself stop the uploader.
        const unsubscribe = me.subscribe((user) => {
          if (user === null) stop.abort();
        });
        try {
          const result = refusal(
            upload("/api/test-upload", new Blob(), { signal: stop.signal }),
          );
          xhr.respond(401, body);
          expect(await result).toMatchObject({
            status: 401,
            message: body ? "sign in" : statusWords(401),
          });
          expect(me.value).toBeNull();
          expect(xhr.aborted).toBe(false);
        } finally {
          unsubscribe();
        }
      }
    },
  );

  test.serial(
    "invalid success JSON is a failure, not an empty result",
    async () => {
      const xhr = fakeXhr();
      const result = upload("/api/test-upload", new Blob(), {});
      xhr.respond(200, "not JSON");
      await expect(result).rejects.toBeInstanceOf(SyntaxError);
    },
  );
});
