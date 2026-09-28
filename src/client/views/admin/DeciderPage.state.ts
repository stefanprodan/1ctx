// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";
import type { DeciderSummary } from "../../../shared/contracts/decider.ts";
import type { CatalogMatch } from "../../../shared/contracts/provider.ts";

type DeciderModel = {
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
  readonly name = signal("");
  readonly isDefault = signal(false);
  readonly providerId = signal("");
  readonly model = signal<DeciderModel | null>(null);
  readonly changing = signal(false);
  // each save sends the whole decider, so the other card waits
  readonly saving = signal(false);
  private before: { providerId: string; model: DeciderModel | null } | null =
    null;

  static of(d: DeciderSummary): DeciderDrafts {
    const drafts = new DeciderDrafts();
    drafts.name.value = d.name;
    drafts.isDefault.value = d.default;
    drafts.providerId.value = d.providerId;
    drafts.model.value = modelOf(d);
    return drafts;
  }

  static blank(providerId: string): DeciderDrafts {
    const drafts = new DeciderDrafts();
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

  // another decider moving the mark changes this row under the page
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
