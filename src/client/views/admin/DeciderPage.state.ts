// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A decider's drafts, one set per decider its page shows and one for
// New decider: the name and the default mark the Identity card saves,
// the provider and the model the Model card saves. A row that changes
// under the page (the mark moved by another decider) carries each field
// the admin has not touched.

import { signal } from "@preact/signals";
import type { DeciderSummary } from "../../../shared/contracts/decider.ts";
import type { CatalogMatch } from "../../../shared/contracts/provider.ts";

// what the page keeps of a pick: what its row shows of it
export type DeciderModel = {
  id: string;
  contextLength: number | null;
  promptPrice: number | null;
};

const modelOf = (d: DeciderSummary): DeciderModel => ({
  id: d.model,
  contextLength: d.contextLength,
  promptPrice: d.promptPrice,
});

export class DeciderDrafts {
  readonly deciderId: string | null;
  readonly name = signal("");
  readonly isDefault = signal(false);
  readonly providerId = signal("");
  readonly model = signal<DeciderModel | null>(null);
  // the model's search is open in its place
  readonly changing = signal(false);
  // a card is saving: each save sends the whole decider, so the others
  // wait rather than send what it is about to change
  readonly saving = signal(false);
  // the model the search replaces, to take back on Cancel
  private before: { providerId: string; model: DeciderModel | null } | null =
    null;

  private constructor(deciderId: string | null) {
    this.deciderId = deciderId;
  }

  static of(d: DeciderSummary): DeciderDrafts {
    const drafts = new DeciderDrafts(d.id);
    drafts.name.value = d.name;
    drafts.isDefault.value = d.default;
    drafts.providerId.value = d.providerId;
    drafts.model.value = modelOf(d);
    return drafts;
  }

  // New decider: the search open on the provider given, nothing to take
  // back to
  static blank(providerId: string): DeciderDrafts {
    const drafts = new DeciderDrafts(null);
    drafts.providerId.value = providerId;
    drafts.changing.value = true;
    return drafts;
  }

  get cancellable(): boolean {
    return this.before?.model != null;
  }

  generalDirty(d: DeciderSummary): boolean {
    return (
      this.name.value.trim() !== d.name || this.isDefault.value !== d.default
    );
  }

  modelDirty(d: DeciderSummary): boolean {
    return (
      this.providerId.value !== d.providerId || this.model.value?.id !== d.model
    );
  }

  resetGeneral(d: DeciderSummary): void {
    this.name.value = d.name;
    this.isDefault.value = d.default;
  }

  resetModel(d: DeciderSummary): void {
    this.providerId.value = d.providerId;
    this.model.value = modelOf(d);
    this.changing.value = false;
    this.before = null;
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

  // another provider's catalog: the model goes with the old one
  chooseProvider(id: string): void {
    if (id === this.providerId.value) return;
    this.providerId.value = id;
    this.model.value = null;
  }

  pick(m: CatalogMatch): void {
    this.model.value = {
      id: m.id,
      contextLength: m.contextLength,
      promptPrice: m.promptPrice,
    };
    this.before = null;
    this.changing.value = false;
  }

  async save<T>(call: () => Promise<T>): Promise<T> {
    this.saving.value = true;
    try {
      return await call();
    } finally {
      this.saving.value = false;
    }
  }

  // the row changed under the page: what the admin left alone follows
  follow(before: DeciderSummary, after: DeciderSummary): void {
    if (this.name.value.trim() === before.name) this.name.value = after.name;
    if (this.isDefault.value === before.default) {
      this.isDefault.value = after.default;
    }
    if (!this.changing.value && !this.modelDirty(before)) {
      this.providerId.value = after.providerId;
      this.model.value = modelOf(after);
    }
  }
}
