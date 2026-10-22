// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Config board's Dictation page: its words, the Model card's draft,
// what the switch and the Model card draw on and off, Save and the switch
// against the routes, and the provider page that keeps a provider
// Dictation uses, on or off.

import { afterEach, describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { options } from "preact";
import { render } from "preact-render-to-string";
import { ZONES } from "../../../src/client/app/zones.ts";
import { agents } from "../../../src/client/data/agents.ts";
import { deciders } from "../../../src/client/data/deciders.ts";
import {
  dictation,
  dictationError,
  loadDictation,
  saveDictation,
  switchDictation,
  transcribe,
} from "../../../src/client/data/dictation.ts";
import {
  dictationOn,
  loadDictationOn,
  me,
} from "../../../src/client/data/me.ts";
import { overview } from "../../../src/client/data/overview.ts";
import { providers } from "../../../src/client/data/providers.ts";
import type { Save } from "../../../src/client/lib/save.ts";
import { RowsSwitch } from "../../../src/client/ui/Rows.tsx";
import { SettingForm } from "../../../src/client/ui/Setting.tsx";
import {
  audioMinutes,
  dictationFieldOf,
  dictationLine,
  dictationMeta,
  modelLine,
  switchCheck,
  transcriptionProviders,
} from "../../../src/client/views/admin/Dictation.model.ts";
import { DictationDrafts } from "../../../src/client/views/admin/Dictation.state.ts";
import {
  Dictation,
  DictationSwitch,
} from "../../../src/client/views/admin/Dictation.tsx";
import { DictationCard } from "../../../src/client/views/admin/DictationCard.tsx";
import { DraftFoot } from "../../../src/client/views/admin/DraftFoot.tsx";
import { ModelPicker } from "../../../src/client/views/admin/ModelPicker.tsx";
import { ProviderPage } from "../../../src/client/views/admin/ProviderPage.tsx";
import { providerDeleteLine } from "../../../src/client/views/admin/Providers.model.ts";
import type { OverviewResponse } from "../../../src/shared/api/admin.ts";
import type { DictationResponse } from "../../../src/shared/api/dictation.ts";
import type { DictationSettings } from "../../../src/shared/contracts/dictation.ts";
import type { CatalogMatch } from "../../../src/shared/contracts/provider.ts";
import { settle } from "../../helpers/async.ts";
import { deferredFetch } from "../../helpers/client-fetch.ts";
import { admin, provider } from "../../helpers/client-fixtures.ts";

const router = provider();
const mlx = provider({
  id: "pr2",
  name: "mlx",
  wire: "openai-compatible",
  keyName: null,
});
const claude = provider({ id: "pr3", name: "claude", wire: "anthropic" });

const settings: DictationSettings = {
  providerId: "pr1",
  model: "mistralai/voxtral-mini-transcribe-3-0",
  updatedAt: 5,
};

const voxtral: CatalogMatch = {
  id: "mistralai/voxtral-mini-transcribe-3-0",
  name: "Mistral: Voxtral Mini Transcribe 3",
  contextLength: null,
  promptPrice: 58.3333,
  completionPrice: 0,
  tools: false,
  reasoning: false,
  thinkingRequired: false,
  reasoningKnown: true,
  described: true,
};
const whisper: CatalogMatch = {
  ...voxtral,
  id: "openai/whisper-large-v3-turbo",
  name: "OpenAI: Whisper Large v3 Turbo",
  promptPrice: 6.6667,
};

describe("the Dictation words", () => {
  test("only OpenRouter and OpenAI-compatible providers transcribe", () => {
    expect(transcriptionProviders([router, mlx, claude])).toEqual([
      router,
      mlx,
    ]);
  });

  test("a price per second reads per thousand minutes", () => {
    expect(dictationMeta(voxtral)).toBe("$3.5 per 1,000 minutes");
    expect(dictationMeta(whisper)).toBe("$0.4 per 1,000 minutes");
    expect(dictationMeta({ promptPrice: 0 })).toBe("free");
    expect(dictationMeta({ promptPrice: null })).toBe("");
  });

  test("the lines say what the switch and the model mean", () => {
    expect(dictationLine(true)).toBe(
      "Allows users to dictate in the composer.",
    );
    expect(dictationLine(false)).toBe("The composer has no mic.");
    expect(modelLine(true)).toBe("This model turns what users say into text.");
    expect(modelLine(false)).toBe(
      "Pick the model that turns what users say into text.",
    );
  });

  test("on needs a saved model", () => {
    expect(switchCheck(true, false)).toBe("Pick a model first");
    expect(switchCheck(true, true)).toBeNull();
    expect(switchCheck(false, false)).toBeNull();
  });

  test("a server refusal lands at its field", () => {
    expect(dictationFieldOf("claude serves no transcription models")).toBe(
      "provider",
    );
    expect(dictationFieldOf("no such provider")).toBe("provider");
    expect(
      dictationFieldOf("router does not list x/y as a transcription model"),
    ).toBe("model");
    expect(dictationFieldOf("the catalog did not answer")).toBeUndefined();
  });
});

describe("the Dictation draft", () => {
  test("off, it opens on the search with no way back", () => {
    const d = DictationDrafts.of(null, "pr1");
    expect(d.providerId.value).toBe("pr1");
    expect(d.changing.value).toBe(true);
    expect(d.cancellable).toBe(false);
    expect(d.dirty(null)).toBe(false);
    d.pick(voxtral);
    expect(d.model.value).toEqual({
      id: voxtral.id,
      meta: "$3.5 per 1,000 minutes",
    });
    expect(d.changing.value).toBe(false);
    expect(d.dirty(null)).toBe(true);
  });

  test("on, a change can be taken back, another provider drops the model", () => {
    const d = DictationDrafts.of(settings, "pr2");
    expect(d.providerId.value).toBe("pr1");
    expect(d.dirty(settings)).toBe(false);
    d.change();
    expect(d.cancellable).toBe(true);
    d.chooseProvider("pr2");
    expect(d.model.value).toBeNull();
    d.cancel();
    expect(d.providerId.value).toBe("pr1");
    expect(d.model.value?.id).toBe(settings.model);
    d.change();
    d.pick(whisper);
    expect(d.dirty(settings)).toBe(true);
    d.reset(settings, "pr2");
    expect(d.dirty(settings)).toBe(false);
    d.reset(null, "pr2");
    expect(d.providerId.value).toBe("pr2");
    expect(d.changing.value).toBe(true);
  });
});

describe("the Dictation draft following the setting", () => {
  const other: DictationSettings = { ...settings, model: whisper.id };

  test("an untouched draft takes a setting changed elsewhere", () => {
    const d = DictationDrafts.of(settings, "pr1");
    d.follow(settings, other, "pr1");
    expect(d.model.value?.id).toBe(whisper.id);
    d.follow(other, null, "pr2");
    expect(d.model.value).toBeNull();
    expect(d.providerId.value).toBe("pr2");
    expect(d.changing.value).toBe(true);
    d.follow(null, settings, "pr2");
    expect(d.model.value?.id).toBe(settings.model);
  });

  test("an edit is kept, and an open change", () => {
    const d = DictationDrafts.of(settings, "pr1");
    d.change();
    d.pick(whisper);
    d.follow(settings, { ...settings, model: "x/y" }, "pr1");
    expect(d.model.value?.id).toBe(whisper.id);
    const open = DictationDrafts.of(settings, "pr1");
    open.change();
    open.follow(settings, other, "pr1");
    expect(open.changing.value).toBe(true);
    expect(open.model.value?.id).toBe(settings.model);
  });

  test("the same setting answered again keeps the draft's words", () => {
    const d = DictationDrafts.of(settings, "pr1");
    d.model.value = { id: settings.model, meta: "$3.5 per 1,000 minutes" };
    d.follow(settings, { ...settings, updatedAt: 9 }, "pr1");
    expect(d.model.value?.meta).toBe("$3.5 per 1,000 minutes");
  });
});

// one render of the card and the handlers it binds; the card's draft
// lives in the closures, so the calls run on the one render's state
function draw(state: DictationResponse, saving = signal(false)) {
  let submit: ((e: Event) => void) | undefined;
  let pick: ((m: CatalogMatch) => void) | undefined;
  let save: Save | undefined;
  let locked: unknown;
  const previous = options.vnode;
  options.vnode = (v) => {
    previous?.(v);
    const props = v.props as Record<string, unknown>;
    if (v.type === "form") submit = props.onSubmit as (e: Event) => void;
    if (v.type === DraftFoot) locked = props.locked;
    if (v.type === ModelPicker) {
      pick = props.onPick as (m: CatalogMatch) => void;
      save = props.save as Save;
    }
  };
  let html: string;
  try {
    html = render(<DictationCard state={state} saving={saving} />);
  } finally {
    options.vnode = previous;
  }
  return {
    html,
    submit: () => submit!(new Event("submit", { cancelable: true })),
    pick: (m: CatalogMatch) => pick!(m),
    save: () => save!,
    locked,
  };
}

describe("the Dictation card", () => {
  afterEach(() => {
    providers.value = null;
    dictation.value = null;
    dictationError.value = null;
    dictationOn.value = false;
  });

  test.serial("never set: the search on the first provider", () => {
    providers.value = [router, claude];
    const { html } = draw({ enabled: false, settings: null });
    expect(html).toContain(">Model<");
    expect(html).toContain(modelLine(false));
    expect(html).toContain('name="model"');
    expect(html).toContain("router");
    expect(html).not.toContain("Turn off");
    expect(html).not.toContain("claude");
  });

  test.serial("saved: the model with Change, on or off", () => {
    providers.value = [router, mlx];
    for (const enabled of [true, false]) {
      const { html } = draw({ enabled, settings });
      expect(html).toContain(modelLine(true));
      expect(html).toContain(settings.model);
      expect(html).toContain(">Change<");
      expect(html).not.toContain("Turn off");
      expect(html).not.toContain('name="model"');
    }
  });

  test.serial("no provider transcribes: says so with a link", () => {
    providers.value = [claude];
    const { html } = draw({ enabled: false, settings: null });
    expect(html).toContain("No provider can transcribe.");
    expect(html).toContain('href="/admin/config/providers"');
    expect(html).not.toContain("<form");
  });
});

describe("the Dictation card's calls", () => {
  const calls = deferredFetch();
  const sent = (n: number) => ({
    method: calls[n]!.init?.method ?? "GET",
    url: calls[n]!.url,
    body: calls[n]!.init?.body
      ? JSON.parse(String(calls[n]!.init?.body))
      : null,
  });

  afterEach(() => {
    providers.value = null;
    dictation.value = null;
    dictationError.value = null;
    dictationOn.value = false;
    me.value = undefined;
  });

  test.serial(
    "loads the setting and says whether Dictation is on",
    async () => {
      me.value = admin();
      const loading = loadDictation();
      expect(sent(0)).toMatchObject({
        method: "GET",
        url: "/api/admin/dictation",
      });
      calls[0]!.answer(Response.json({ enabled: true, settings }));
      await loading;
      expect(dictation.value).toEqual({ enabled: true, settings });
      expect(dictationOn.value).toBe(true);
      // a model kept while off offers no mic
      const again = loadDictation();
      calls[1]!.answer(Response.json({ enabled: false, settings }));
      await again;
      expect(dictationOn.value).toBe(false);
    },
  );

  test.serial("Save sends the pick and leaves the switch", async () => {
    me.value = admin();
    providers.value = [router, mlx];
    dictation.value = { enabled: false, settings: null };
    const card = draw({ enabled: false, settings: null });
    card.pick(voxtral);
    card.submit();
    await settle();
    expect(sent(0)).toEqual({
      method: "PUT",
      url: "/api/admin/dictation",
      // the first by name: mlx before router
      body: { providerId: "pr2", model: voxtral.id },
    });
    calls[0]!.answer(Response.json({ enabled: false, settings }));
    await settle();
    expect(dictation.value).toEqual({ enabled: false, settings });
    expect(dictationOn.value).toBe(false);
    expect(card.save().status.value).toBe("done");
  });

  test.serial("a refusal naming the model lands at the model", async () => {
    me.value = admin();
    providers.value = [router];
    dictation.value = { enabled: false, settings: null };
    const card = draw({ enabled: false, settings: null });
    card.pick(whisper);
    card.submit();
    await settle();
    calls[0]!.answer(
      Response.json(
        {
          error: `router does not list ${whisper.id} as a transcription model`,
        },
        { status: 400 },
      ),
    );
    await settle();
    expect(card.save().fieldError("model")).toContain("does not list");
    expect(dictation.value).toEqual({ enabled: false, settings: null });
    expect(dictationOn.value).toBe(false);
  });

  test.serial("nothing picked sends nothing", async () => {
    providers.value = [router];
    const card = draw({ enabled: false, settings: null });
    card.submit();
    await settle();
    expect(calls).toHaveLength(0);
    expect(card.save().fieldError("model")).toBe("Pick a model.");
  });

  test.serial(
    "an older answer of who is signed in never undoes a save",
    async () => {
      me.value = admin();
      dictationOn.value = false;
      // a sign-in's ask whether Dictation is on, still out
      const asking = loadDictationOn();
      expect(sent(0)).toMatchObject({ method: "GET", url: "/api/me" });
      const saving = switchDictation({ enabled: true });
      expect(sent(1)).toEqual({
        method: "PATCH",
        url: "/api/admin/dictation",
        body: { enabled: true },
      });
      calls[1]!.answer(Response.json({ enabled: true, settings }));
      await saving;
      expect(dictationOn.value).toBe(true);
      calls[0]!.answer(
        Response.json({ user: admin(), emailOn: false, dictationOn: false }),
      );
      await asking;
      expect(dictationOn.value).toBe(true);
      // and an ask made after the save lands as usual
      const later = loadDictationOn();
      calls[2]!.answer(
        Response.json({ user: admin(), emailOn: false, dictationOn: false }),
      );
      await later;
      expect(dictationOn.value).toBe(false);
    },
  );

  test.serial("a load asked while a save is out never undoes it", async () => {
    me.value = admin();
    const saving = switchDictation({ enabled: true });
    const loading = loadDictation();
    // the save lands first, then the load's older answer
    calls[0]!.answer(Response.json({ enabled: true, settings }));
    await saving;
    calls[1]!.answer(Response.json({ enabled: false, settings: null }));
    await loading;
    expect(dictation.value).toEqual({ enabled: true, settings });
    expect(dictationOn.value).toBe(true);
    // the other order: the load lands, then the save over it
    const off = switchDictation({ enabled: false });
    const again = loadDictation();
    calls[3]!.answer(Response.json({ enabled: true, settings }));
    await again;
    calls[2]!.answer(Response.json({ enabled: false, settings }));
    await off;
    expect(dictation.value).toEqual({ enabled: false, settings });
    expect(dictationOn.value).toBe(false);
  });

  test.serial("a clip's 404 never hides a mic turned on after it", async () => {
    me.value = admin();
    dictationOn.value = false;
    const clip = transcribe(new Uint8Array(0)).catch(() => {});
    const on = switchDictation({ enabled: true });
    calls[1]!.answer(Response.json({ enabled: true, settings }));
    await on;
    calls[0]!.answer(
      Response.json({ error: "Dictation is off" }, { status: 404 }),
    );
    await clip;
    expect(dictationOn.value).toBe(true);
  });

  test.serial("a save that names the model again keeps it", async () => {
    me.value = admin();
    const saving = saveDictation({ providerId: "pr1", model: voxtral.id });
    calls[0]!.answer(Response.json({ enabled: true, settings }));
    await saving;
    expect(dictationOn.value).toBe(true);
  });
});

// one render of the switch card and the handlers it binds
function drawSwitch(state: DictationResponse, saving = signal(false)) {
  let submit: ((e: Event) => void) | undefined;
  let flip: (() => void) | undefined;
  let save: Save | undefined;
  const previous = options.vnode;
  options.vnode = (v) => {
    previous?.(v);
    const props = v.props as Record<string, unknown>;
    if (v.type === "form") submit = props.onSubmit as (e: Event) => void;
    if (v.type === RowsSwitch) flip = props.onClick as () => void;
    if (v.type === SettingForm) save = props.save as Save;
  };
  let html: string;
  try {
    html = render(<DictationSwitch state={state} saving={saving} />);
  } finally {
    options.vnode = previous;
  }
  return {
    html,
    flip: () => flip!(),
    save: () => save!,
    submit: () => submit!(new Event("submit", { cancelable: true })),
  };
}

describe("the Dictation switch", () => {
  const calls = deferredFetch();
  const sent = (n: number) => ({
    method: calls[n]!.init?.method ?? "GET",
    url: calls[n]!.url,
    body: calls[n]!.init?.body
      ? JSON.parse(String(calls[n]!.init?.body))
      : null,
  });

  afterEach(() => {
    providers.value = null;
    dictation.value = null;
    dictationError.value = null;
    dictationOn.value = false;
    me.value = undefined;
  });

  test.serial("draws its state in the head", () => {
    const on = drawSwitch({ enabled: true, settings });
    expect(on.html).toContain(">Dictation<");
    expect(on.html).toContain(dictationLine(true));
    expect(on.html).toContain('aria-checked="true"');
    const off = drawSwitch({ enabled: false, settings });
    expect(off.html).toContain(dictationLine(false));
    expect(off.html).toContain('aria-checked="false"');
  });

  test.serial("on with no model saved is held back", async () => {
    const card = drawSwitch({ enabled: false, settings: null });
    card.flip();
    card.submit();
    await settle();
    expect(calls).toHaveLength(0);
    expect(card.save().notice()?.error).toBe("Pick a model first");
  });

  test.serial("a flip out holds the Model card's Save", async () => {
    me.value = admin();
    providers.value = [router];
    dictation.value = { enabled: false, settings };
    const saving = signal(false);
    const on = drawSwitch({ enabled: false, settings }, saving);
    on.flip();
    on.submit();
    await settle();
    expect(saving.value).toBe(true);
    expect(draw({ enabled: false, settings }, saving).locked).toBe(true);
    calls[0]!.answer(Response.json({ enabled: true, settings }));
    await settle();
    expect(saving.value).toBe(false);
    expect(draw({ enabled: true, settings }, saving).locked).toBe(false);
  });

  test.serial("a write that lands clears a failed reload", async () => {
    me.value = admin();
    dictation.value = { enabled: false, settings };
    const on = switchDictation({ enabled: true });
    const reload = loadDictation();
    calls[1]!.answer(
      Response.json({ error: "the server is busy" }, { status: 503 }),
    );
    await reload;
    expect(dictationError.value).not.toBeNull();
    calls[0]!.answer(Response.json({ enabled: true, settings }));
    await on;
    expect(dictationError.value).toBeNull();
    expect(dictation.value).toEqual({ enabled: true, settings });
  });

  test.serial("a flip saves on Save and moves the mic", async () => {
    me.value = admin();
    dictation.value = { enabled: false, settings };
    const on = drawSwitch({ enabled: false, settings });
    on.flip();
    expect(calls).toHaveLength(0);
    on.submit();
    await settle();
    expect(sent(0)).toEqual({
      method: "PATCH",
      url: "/api/admin/dictation",
      body: { enabled: true },
    });
    calls[0]!.answer(Response.json({ enabled: true, settings }));
    await settle();
    expect(dictationOn.value).toBe(true);
    const off = drawSwitch({ enabled: true, settings });
    off.flip();
    off.submit();
    await settle();
    expect(sent(1).body).toEqual({ enabled: false });
    calls[1]!.answer(Response.json({ enabled: false, settings }));
    await settle();
    // off keeps the model
    expect(dictation.value).toEqual({ enabled: false, settings });
    expect(dictationOn.value).toBe(false);
  });
});

describe("a provider Dictation uses", () => {
  afterEach(() => {
    providers.value = null;
    agents.value = null;
    deciders.value = null;
    dictation.value = null;
  });

  test("the Delete line names Dictation with the rest", () => {
    expect(providerDeleteLine(0, 0, true)).toBe(
      "Dictation runs on it. Move it to another provider first.",
    );
    expect(providerDeleteLine(2, 0, true)).toBe(
      "2 agents and Dictation run on it. Move them to another provider first.",
    );
    expect(providerDeleteLine(1, 1, true)).toBe(
      "1 agent, 1 decider and Dictation run on it. Move them to another provider first.",
    );
  });

  test.serial("its page lists Dictation and keeps Delete off", () => {
    providers.value = [router];
    agents.value = [];
    deciders.value = [];
    // off keeps the model, so the provider stays held
    for (const enabled of [true, false]) {
      dictation.value = { enabled, settings };
      const html = render(<ProviderPage params={{ name: "router" }} />);
      expect(html).toContain(">Dictation<");
      expect(html).toContain(settings.model);
      expect(html).toContain(providerDeleteLine(0, 0, true));
      expect(html).toMatch(/disabled[^>]*>Delete</);
    }
    dictation.value = { enabled: false, settings: null };
    const free = render(<ProviderPage params={{ name: "router" }} />);
    expect(free).toContain("Nothing runs on it.");
  });
});

describe("the Dictation page", () => {
  afterEach(() => {
    providers.value = null;
    dictation.value = null;
    dictationError.value = null;
    overview.value = null;
  });

  test("audio reads in minutes, a tenth under ten", () => {
    expect(audioMinutes(0)).toBe("0 min");
    expect(audioMinutes(90)).toBe("1.5 min");
    expect(audioMinutes(3600)).toBe("60 min");
    expect(audioMinutes(150_000)).toBe("2.5K min");
  });

  test("Config lists it right after Deciders", () => {
    const config = ZONES.find((z) => z.label === "Config")!;
    const labels = config.pages.map((p) => p.label);
    expect(labels[labels.indexOf("Deciders") + 1]).toBe("Dictation");
    expect(config.pages.find((p) => p.label === "Dictation")?.href).toBe(
      "/admin/config/dictation",
    );
  });

  test.serial("the switch, the Model card, and the last 30 days", () => {
    providers.value = [router];
    dictation.value = { enabled: true, settings };
    overview.value = {
      range: "30d",
      totals: {
        dictationClips: 1234,
        dictationSeconds: 90,
        dictationCost: null,
      },
    } as unknown as OverviewResponse;
    const html = render(<Dictation />);
    expect(html).toMatch(/>Dictation<[\s\S]*role="switch"[\s\S]*>Model</);
    expect(html).toContain(dictationLine(true));
    expect(html).toContain(settings.model);
    expect(html).not.toContain("Turn off");
    expect(html).toContain("Last 30 days");
    expect(html).toMatch(/Clips<[\s\S]*1.23K/);
    expect(html).toMatch(/Audio<[\s\S]*1.5 min/);
    expect(html).toMatch(/Cost<[\s\S]*not priced/);
    overview.value = {
      range: "30d",
      totals: { dictationClips: 2, dictationSeconds: 0, dictationCost: 0.5 },
    } as unknown as OverviewResponse;
    expect(render(<Dictation />)).toContain("$0.50");
  });

  test.serial("a failed load shows on this page", () => {
    providers.value = [router];
    dictationError.value = { words: "the server is busy", status: 503 };
    const html = render(<Dictation />);
    expect(html).toContain("The server is busy.");
    expect(html).not.toContain(">Model<");
  });
});
