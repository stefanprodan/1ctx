// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The model search in the agent form: what was typed, and the matches
// for it once the typing pauses. Only the latest question's answer is
// kept, a failure included, and an empty field clears it. One object
// per open form, disposed with it.

import { signal } from "@preact/signals";
import type { CatalogMatch } from "../../../shared/contracts/provider.ts";
import { says } from "../../lib/format.ts";

export const SEARCH_DELAY_MS = 250;

export class CatalogSearch {
  readonly query = signal("");
  readonly matches = signal<CatalogMatch[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  private turn = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private live = true;

  constructor(
    private readonly ask: (q: string) => Promise<CatalogMatch[]>,
    private readonly delayMs = SEARCH_DELAY_MS,
  ) {}

  type(value: string): void {
    this.query.value = value;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const q = value.trim();
    this.turn++;
    if (q === "") {
      this.matches.value = [];
      this.error.value = null;
      this.busy.value = false;
      return;
    }
    this.busy.value = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run(q);
    }, this.delayMs);
  }

  clear(): void {
    this.type("");
  }

  dispose(): void {
    this.live = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async run(q: string): Promise<void> {
    const turn = this.turn;
    let matches: CatalogMatch[] = [];
    let failed: string | null = null;
    try {
      matches = await this.ask(q);
    } catch (err) {
      failed = says(err);
    }
    if (!this.live || turn !== this.turn) return;
    this.busy.value = false;
    this.error.value = failed;
    this.matches.value = failed === null ? matches : [];
  }
}
