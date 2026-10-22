// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Dictation over a composed app: the setting on a transcription wire with a
// model its catalog lists, its switch, the provider it holds on or off,
// dictationOn in /api/me,
// and POST /api/transcribe refusing off, the cap, a clip in flight, a
// large body and a bad header before any provider call; then a clip
// reaching the provider as multipart, its text tidied, its usage row,
// a closed request aborting the call and a refusal's fixed words.

import { describe, expect, test } from "bun:test";
import { HOUR_MS } from "../../../src/server/lib/clock.ts";
import {
  REFUSED,
  TRANSCRIBE_TIMEOUT_MS,
} from "../../../src/server/providers/index.ts";
import type { MeResponse } from "../../../src/shared/api/access.ts";
import type { DictationResponse } from "../../../src/shared/api/dictation.ts";
import type { CatalogResponse } from "../../../src/shared/api/providers.ts";
import {
  collectLogs,
  fakeFetch,
  GEMINI_URL,
  hashPassword,
  MLX_URL,
  PROVIDER_URL,
  type TestClient,
  testApp,
} from "../../helpers/app.ts";
import { wavOf } from "../../helpers/dictation.ts";

const VOXTRAL = "mistralai/voxtral-mini-transcribe-3-0";
const ASR = "mlx-community/Qwen3-ASR-1.7B-8bit";
const SPOKEN =
  "Find me a pharmacy that is open now near the old town. And tell me how to get there by tram.";

type Upstream = { url: string; signal: AbortSignal | null; form: FormData };

// a provider whose transcription waits until the test answers it
function heldFetch() {
  const fake = fakeFetch();
  const held: Upstream[] = [];
  let reached: () => void = () => {};
  let next = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let answer: (res: Response) => void = () => {};
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (!url.endsWith("/audio/transcriptions")) {
      return fake.fetcher(input, init);
    }
    const signal = init?.signal ?? null;
    held.push({ url, signal, form: init?.body as FormData });
    reached();
    return new Promise<Response>((resolve, reject) => {
      answer = resolve;
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  }) as unknown as typeof fetch;
  return {
    fetcher,
    held,
    // once the next transcription reached the provider
    reached: async () => {
      await next;
      next = new Promise<void>((resolve) => {
        reached = resolve;
      });
    },
    answer: (res: Response) => answer(res),
  };
}

async function setup(options: { fetcher?: typeof fetch } = {}) {
  const logs = collectLogs();
  const app = await testApp({
    secrets: { "provider-router": "sk-router" },
    logFactory: logs.logFactory,
    fetcher: options.fetcher,
  });
  const admin = app.client();
  await admin.login("admin", "hunter2-test");
  const provider = async (name: string, wire: string, baseUrl: string) => {
    const res = await admin.call("POST", "/api/providers", {
      body: {
        name,
        wire,
        baseUrl,
        keyName: name === "router" ? "provider-router" : null,
      },
    });
    return ((await res.json()) as { provider: { id: string } }).provider.id;
  };
  const router = await provider("router", "openrouter", PROVIDER_URL);
  const mlx = await provider("mlx", "openai-compatible", MLX_URL);
  const gemini = await provider("gemini", "gemini", GEMINI_URL);
  const user = app.createUser({
    username: "speaker",
    fullName: "Speaker",
    email: "speaker@example.com",
    role: "member",
    passwordHash: await hashPassword("password-test"),
    mustChangePassword: false,
    now: app.now.value,
  });
  const member = app.client();
  await member.login("speaker", "password-test");
  const save = (providerId: string, model: string) =>
    admin.call("PUT", "/api/admin/dictation", { body: { providerId, model } });
  const flip = (enabled: boolean) =>
    admin.call("PATCH", "/api/admin/dictation", { body: { enabled } });
  // a model saved and switched on
  const on = async (providerId: string, model: string) => {
    expect((await save(providerId, model)).status).toBe(200);
    expect((await flip(true)).status).toBe(200);
  };
  const transcriptions = () =>
    app.fetched.filter((call) => call.url.endsWith("/audio/transcriptions"));
  const close = async () => {
    await app.shutdown();
    app.db.close();
  };
  return {
    app,
    logs,
    admin,
    member,
    user,
    router,
    mlx,
    gemini,
    save,
    flip,
    on,
    transcriptions,
    close,
  };
}

const post = (
  client: TestClient,
  bytes: Uint8Array<ArrayBuffer>,
  options: { type?: string; signal?: AbortSignal } = {},
) =>
  client.call("POST", "/api/transcribe", {
    bytes,
    headers: { "content-type": options.type ?? "audio/wav" },
    signal: options.signal,
  });

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: string }).error;

const usageRows = (s: Awaited<ReturnType<typeof setup>>) =>
  s.app.db
    .query<
      {
        user_id: string;
        provider_id: string;
        provider_name: string;
        model: string;
        seconds: number;
        cost: number | null;
      },
      []
    >(
      "select user_id, provider_id, provider_name, model, seconds, cost from dictation_usage",
    )
    .all();

const addUsage = (
  s: Awaited<ReturnType<typeof setup>>,
  count: number,
  at: number,
) => {
  for (let i = 0; i < count; i++) {
    s.app.db
      .query(
        `insert into dictation_usage (id, user_id, provider_id, provider_name,
           model, seconds, cost, created_at)
         values (?, ?, 'p', 'router', 'm', 1, null, ?)`,
      )
      .run(`v${at}-${i}`, s.user.id, at);
  }
};

describe("the Dictation setting", () => {
  test("takes a transcription model on a transcription wire", async () => {
    const s = await setup();
    try {
      const off = await s.admin.call("GET", "/api/admin/dictation");
      expect((await off.json()) as DictationResponse).toEqual({
        enabled: false,
        settings: null,
      });
      const gemini = await s.save(s.gemini, "gemini-3.5-flash");
      expect(gemini.status).toBe(400);
      expect(await errorOf(gemini)).toBe(
        "gemini serves no transcription models",
      );
      // mlx-serve lists its chat models too; the catalog keeps the ASR
      const chat = await s.save(s.mlx, "mlx-community/Qwen3.6-27B-8bit");
      expect(chat.status).toBe(400);
      expect(await errorOf(chat)).toBe(
        "mlx does not list mlx-community/Qwen3.6-27B-8bit as a transcription model",
      );
      const saved = await s.save(s.mlx, ASR);
      expect(saved.status).toBe(200);
      // a first save starts off
      expect((await saved.json()) as DictationResponse).toEqual({
        enabled: false,
        settings: { providerId: s.mlx, model: ASR, updatedAt: s.app.now.value },
      });
      expect((await s.save(s.router, VOXTRAL)).status).toBe(200);
      expect((await s.save(s.router, "nobody/none")).status).toBe(400);
      const read = await s.admin.call("GET", "/api/admin/dictation");
      expect(((await read.json()) as DictationResponse).settings?.model).toBe(
        VOXTRAL,
      );
      expect(
        s.logs.events
          .filter((e) => e.area === "dictation")
          .map((e) => [e.msg, e.fields]),
      ).toEqual([
        ["dictation saved", { provider: "mlx", model: ASR }],
        ["dictation saved", { provider: "router", model: VOXTRAL }],
      ]);
    } finally {
      await s.close();
    }
  });

  test("the catalog search serves the transcription kind", async () => {
    const s = await setup();
    try {
      const search = async (id: string, q: string) =>
        s.admin.call(
          "GET",
          `/api/providers/${id}/catalog?q=${q}&kind=transcription`,
        );
      const mlx = await search(s.mlx, "qwen");
      expect(
        ((await mlx.json()) as CatalogResponse).matches.map((m) => m.id),
      ).toEqual([ASR]);
      const router = await search(s.router, "voxtral");
      expect(
        ((await router.json()) as CatalogResponse).matches.map((m) => m.id),
      ).toEqual([VOXTRAL]);
      const gemini = await search(s.gemini, "flash");
      expect(gemini.status).toBe(400);
      expect(await errorOf(gemini)).toBe(
        "gemini serves no transcription models",
      );
    } finally {
      await s.close();
    }
  });

  test("a switch turns it on and off and keeps the model", async () => {
    const s = await setup();
    try {
      const me = async (client: TestClient) =>
        ((await (await client.call("GET", "/api/me")).json()) as MeResponse)
          .dictationOn;
      const nobody = s.app.client();
      const bare = await s.flip(true);
      expect(bare.status).toBe(400);
      expect(await errorOf(bare)).toBe("pick a model first");
      expect((await s.flip(false)).status).toBe(200);
      const odd = await s.admin.call("PATCH", "/api/admin/dictation", {
        body: { enabled: "yes" },
      });
      expect(odd.status).toBe(400);
      expect(await errorOf(odd)).toBe("enabled must be a boolean");
      await s.save(s.mlx, ASR);
      expect(await me(s.member)).toBe(false);
      const on = await s.flip(true);
      expect((await on.json()) as DictationResponse).toEqual({
        enabled: true,
        settings: { providerId: s.mlx, model: ASR, updatedAt: s.app.now.value },
      });
      expect(await me(s.member)).toBe(true);
      expect(await me(nobody)).toBe(false);
      // a later save keeps the switch
      await s.save(s.router, VOXTRAL);
      expect(await me(s.member)).toBe(true);
      const off = await s.flip(false);
      expect((await off.json()) as DictationResponse).toMatchObject({
        enabled: false,
        settings: { providerId: s.router, model: VOXTRAL },
      });
      expect(await me(s.member)).toBe(false);
      const clip = await post(s.member, wavOf(32_000));
      expect(clip.status).toBe(404);
      expect(await errorOf(clip)).toBe("Dictation is off");
      expect(s.transcriptions()).toEqual([]);
      // off keeps the model, so its provider stays held
      const held = await s.admin.call("DELETE", `/api/providers/${s.router}`);
      expect(held.status).toBe(409);
      expect(await errorOf(held)).toBe("Dictation uses router");
      expect(
        (await s.admin.call("DELETE", `/api/providers/${s.mlx}`)).status,
      ).toBe(200);
      await s.flip(true);
      expect(await me(s.member)).toBe(true);
      expect(
        s.logs.events.filter((e) => e.area === "dictation").map((e) => e.msg),
      ).toEqual([
        "dictation saved",
        "dictation turned on",
        "dictation saved",
        "dictation turned off",
        "dictation turned on",
      ]);
    } finally {
      await s.close();
    }
  });
});

describe("POST /api/transcribe", () => {
  test("refuses before any provider call", async () => {
    const s = await setup();
    try {
      const clip = wavOf(32_000);
      const off = await post(s.member, clip);
      expect(off.status).toBe(404);
      expect(await errorOf(off)).toBe("Dictation is off");
      await s.on(s.router, VOXTRAL);
      const huge = await post(s.member, wavOf(10 * 1024 * 1024));
      expect(huge.status).toBe(413);
      const stereo = await post(
        s.member,
        wavOf(32_000, { channels: 2, byteRate: 64_000, blockAlign: 4 }),
      );
      expect(stereo.status).toBe(400);
      expect(await errorOf(stereo)).toBe(
        "the clip must be 16-bit PCM, mono, 16 kHz",
      );
      const mp4 = await post(s.member, clip, { type: "audio/mp4" });
      expect(mp4.status).toBe(400);
      expect(await errorOf(mp4)).toBe("the clip must be audio/wav");
      // the cap counts the last hour's rows alone
      addUsage(s, 5, s.app.now.value - HOUR_MS - 1);
      addUsage(s, 30, s.app.now.value - 10 * 60_000);
      const capped = await post(s.member, clip);
      expect(capped.status).toBe(429);
      expect(await errorOf(capped)).toBe("too many clips, try later");
      expect(capped.headers.get("retry-after")).toBe("3000");
      expect(s.transcriptions()).toEqual([]);
      // the admin's own clips are counted apart
      expect((await post(s.admin, clip)).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  test("a lowered cap says when the count falls below it", async () => {
    const s = await setup();
    try {
      await s.on(s.router, VOXTRAL);
      const lowered = await s.admin.call("PUT", "/api/limits", {
        body: { values: { dictationClipsPerUser: 5 } },
      });
      expect(lowered.status).toBe(200);
      // 30 clips a minute apart, the oldest 50 minutes ago: 26 must
      // leave the hour, the 26th oldest 25 minutes ago
      for (let i = 0; i < 30; i++) {
        addUsage(s, 1, s.app.now.value - (50 - i) * 60_000);
      }
      const capped = await post(s.member, wavOf(32_000));
      expect(capped.status).toBe(429);
      expect(capped.headers.get("retry-after")).toBe(String(35 * 60));
      expect(s.transcriptions()).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("a tab closed during the upload is a 400 and frees the place", async () => {
    const s = await setup();
    try {
      await s.on(s.mlx, ASR);
      const clip = wavOf(64_000);
      let pulled: () => void = () => {};
      const reading = new Promise<void>((resolve) => {
        pulled = resolve;
      });
      let sent = false;
      // the header goes, then the body waits as a slow upload does
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) {
            pulled();
            return new Promise(() => {});
          }
          sent = true;
          controller.enqueue(clip.subarray(0, 1024));
        },
      });
      const tab = new AbortController();
      const req = new Request("http://1ctx.test/api/transcribe", {
        method: "POST",
        headers: {
          host: "1ctx.test",
          origin: "http://1ctx.test",
          cookie: s.member.cookie!,
          "content-type": "audio/wav",
        },
        body,
        signal: tab.signal,
      });
      const answer = s.app.handle(req, "127.0.0.1");
      await reading;
      tab.abort();
      const stopped = (await answer)!;
      expect(stopped.status).toBe(400);
      expect(await errorOf(stopped)).toBe("the clip was stopped");
      expect(s.logs.events.filter((e) => e.level === "error")).toEqual([]);
      expect(s.transcriptions()).toEqual([]);
      expect((await post(s.member, clip)).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  test("sends the clip as multipart and keeps a usage row", async () => {
    const s = await setup();
    try {
      await s.on(s.router, VOXTRAL);
      const clip = wavOf(153_152);
      const res = await post(s.member, clip, { type: "audio/wav; codecs=1" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: SPOKEN });
      const [call] = s.transcriptions();
      expect(call!.url).toBe(`${PROVIDER_URL}/audio/transcriptions`);
      expect(call!.headers.authorization).toBe("Bearer sk-router");
      expect(call!.form!.get("model")).toBe(VOXTRAL);
      expect(call!.form!.get("response_format")).toBe("json");
      const file = call!.form!.get("file") as File;
      expect(file.name).toBe("clip.wav");
      expect(file.type).toBe("audio/wav");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(clip);
      expect(usageRows(s)).toEqual([
        {
          user_id: s.user.id,
          provider_id: s.router,
          provider_name: "router",
          model: VOXTRAL,
          seconds: 4.786,
          cost: 0.00001593738,
        },
      ]);
      const logged = s.logs.events.filter((e) => e.area === "dictation");
      expect(logged.at(-1)).toEqual({
        level: "info",
        area: "dictation",
        msg: "clip transcribed",
        fields: {
          provider: "router",
          model: VOXTRAL,
          bytes: clip.byteLength,
          clip_ms: 4786,
        },
      });
      expect(JSON.stringify(s.logs.events)).not.toContain("pharmacy");
    } finally {
      await s.close();
    }
  });

  test("mlx-serve names no cost", async () => {
    const s = await setup();
    try {
      await s.on(s.mlx, ASR);
      const res = await post(s.member, wavOf(64_000));
      expect(await res.json()).toEqual({
        text: "Find me a pharmacy that is open now near the old town, and tell me how to get there by tram.",
      });
      expect(s.transcriptions()[0]!.headers.authorization).toBeUndefined();
      expect(usageRows(s)).toEqual([
        {
          user_id: s.user.id,
          provider_id: s.mlx,
          provider_name: "mlx",
          model: ASR,
          seconds: 2,
          cost: null,
        },
      ]);
    } finally {
      await s.close();
    }
  });

  test("one clip in flight per user, and a closed request aborts the call", async () => {
    const held = heldFetch();
    const s = await setup({ fetcher: held.fetcher });
    try {
      await s.on(s.mlx, ASR);
      const tab = new AbortController();
      const first = post(s.member, wavOf(32_000), { signal: tab.signal });
      await held.reached();
      const second = await post(s.member, wavOf(32_000));
      expect(second.status).toBe(409);
      expect(await errorOf(second)).toBe("a clip is already being transcribed");
      expect(held.held).toHaveLength(1);
      tab.abort();
      const stopped = await first;
      expect(stopped.status).toBe(400);
      expect(held.held[0]!.signal!.aborted).toBe(true);
      expect(usageRows(s)).toEqual([]);
      // the place is free again
      const again = post(s.member, wavOf(32_000));
      await held.reached();
      held.answer(Response.json({ text: " again " }));
      expect(await (await again).json()).toEqual({ text: "again" });
    } finally {
      await s.close();
    }
  });

  test("a refusal whose body never cancels still frees the place", async () => {
    const held = heldFetch();
    const s = await setup({ fetcher: held.fetcher });
    try {
      await s.on(s.mlx, ASR);
      const res = post(s.member, wavOf(32_000));
      await held.reached();
      let cancelled = false;
      const stalled = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      });
      held.answer(new Response(stalled, { status: 400 }));
      const failed = await res;
      expect(failed.status).toBe(502);
      expect(cancelled).toBe(true);
      const again = post(s.member, wavOf(32_000));
      await held.reached();
      held.answer(Response.json({ text: "again" }));
      expect((await again).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  test("the route holds its connection past the provider's deadline", async () => {
    const s = await setup();
    try {
      const route = s.app.routes.find((r) => r.path === "/api/transcribe");
      expect(route?.idleSeconds).toBe(180);
      expect(route!.idleSeconds! * 1000).toBeGreaterThan(TRANSCRIBE_TIMEOUT_MS);
    } finally {
      await s.close();
    }
  });

  test("a refusal is a 502 in fixed words", async () => {
    const held = heldFetch();
    const s = await setup({ fetcher: held.fetcher });
    try {
      await s.on(s.mlx, ASR);
      const res = post(s.member, wavOf(32_000));
      await held.reached();
      held.answer(
        new Response(
          await Bun.file(
            `${import.meta.dir}/../../fixtures/providers/transcription/mlx-refusal.json`,
          ).text(),
          { status: 400 },
        ),
      );
      const failed = await res;
      expect(failed.status).toBe(502);
      expect(await errorOf(failed)).toBe("transcription failed");
      expect(usageRows(s)).toEqual([]);
      const warned = s.logs.events.find(
        (e) => e.msg === "transcription failed",
      );
      expect(warned).toEqual({
        level: "warn",
        area: "dictation",
        msg: "transcription failed",
        fields: {
          provider: "mlx",
          model: ASR,
          bytes: 32_044,
          clip_ms: 1000,
          error: REFUSED,
          provider_status: 400,
        },
      });
      expect(JSON.stringify(s.logs.events)).not.toContain("WAV file");
    } finally {
      await s.close();
    }
  });
});
