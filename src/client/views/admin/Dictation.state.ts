// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";
import type { DictationSettings } from "../../../shared/contracts/dictation.ts";
import type { CatalogMatch } from "../../../shared/contracts/provider.ts";
import { dictationMeta } from "./Dictation.model.ts";

type Model = { id: string; meta: string };

// The Model card's draft over the saved model. With none saved, it opens
// on the search with no way back, since there is nothing to go back to.
export class DictationDrafts {
  readonly providerId = signal("");
  readonly model = signal<Model | null>(null);
  readonly changing = signal(false);
  private before: { providerId: string; model: Model | null } | null = null;

  static of(settings: DictationSettings | null, firstProvider: string) {
    const d = new DictationDrafts();
    d.reset(settings, firstProvider);
    return d;
  }

  get cancellable(): boolean {
    return this.before?.model != null;
  }

  dirty(settings: DictationSettings | null): boolean {
    const model = this.model.value;
    if (settings === null) return model !== null;
    return (
      this.providerId.value !== settings.providerId ||
      model?.id !== settings.model
    );
  }

  // the setting changed under the card (another tab, a reload): an
  // untouched draft takes it, an edit is kept
  follow(
    before: DictationSettings | null,
    after: DictationSettings | null,
    firstProvider: string,
  ): void {
    if (same(before, after)) return;
    const open = this.changing.value && before !== null;
    if (!open && !this.dirty(before)) this.reset(after, firstProvider);
  }

  reset(settings: DictationSettings | null, firstProvider: string): void {
    this.before = null;
    if (settings === null) {
      this.providerId.value = firstProvider;
      this.model.value = null;
      this.changing.value = true;
      return;
    }
    this.providerId.value = settings.providerId;
    this.model.value = { id: settings.model, meta: "" };
    this.changing.value = false;
  }

  change(): void {
    this.before = {
      providerId: this.providerId.value,
      model: this.model.value,
    };
    this.changing.value = true;
  }

  cancel(): void {
    if (this.before !== null) {
      this.providerId.value = this.before.providerId;
      this.model.value = this.before.model;
    }
    this.before = null;
    this.changing.value = false;
  }

  chooseProvider(id: string): void {
    if (id === this.providerId.value) return;
    this.providerId.value = id;
    this.model.value = null;
  }

  pick(m: CatalogMatch): void {
    this.model.value = { id: m.id, meta: dictationMeta(m) };
    this.before = null;
    this.changing.value = false;
  }
}

const same = (a: DictationSettings | null, b: DictationSettings | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.providerId === b.providerId &&
    a.model === b.model);
