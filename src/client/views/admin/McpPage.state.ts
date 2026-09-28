// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";
import type { McpServerSummary } from "../../../shared/contracts/mcp.ts";
import type { Patterns } from "../../../shared/mcp.ts";
import { NO_KEY } from "../../lib/secrets.ts";
import { timeoutMs, timeoutText } from "./Mcp.model.ts";
import type { SideFilter } from "./McpTools.model.ts";

const patternsOf = (s: McpServerSummary): Patterns => ({
  read: s.readPatterns,
  write: s.writePatterns,
  excluded: s.excludedPatterns,
});

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((p, i) => p === b[i]);

const samePatterns = (a: Patterns, b: Patterns) =>
  sameList(a.read, b.read) &&
  sameList(a.write, b.write) &&
  sameList(a.excluded, b.excluded);

export class McpDrafts {
  readonly url = signal("");
  readonly keyName = signal(NO_KEY);

  readonly read = signal(true);
  readonly write = signal(false);
  readonly timeout = signal("");

  readonly instructionsOn = signal(true);

  readonly patterns = signal<Patterns>({ read: [], write: [], excluded: [] });
  readonly q = signal("");
  readonly filter = signal<SideFilter>("all");
  readonly picked = signal<string[]>([]);
  // what the last move did, until the next edit
  readonly moved = signal<string[]>([]);

  static of(server: McpServerSummary): McpDrafts {
    const d = new McpDrafts();
    d.resetEndpoint(server);
    d.resetOffer(server);
    d.resetTimeout(server);
    d.resetInstructions(server);
    d.resetTools(server);
    return d;
  }

  resetEndpoint(s: McpServerSummary): void {
    this.url.value = s.url;
    this.keyName.value = s.keyName ?? NO_KEY;
  }

  resetOffer(s: McpServerSummary): void {
    this.read.value = s.read;
    this.write.value = s.write;
  }

  resetTimeout(s: McpServerSummary): void {
    this.timeout.value = timeoutText(s.timeoutMs);
  }

  resetInstructions(s: McpServerSummary): void {
    this.instructionsOn.value = s.instructionsOn;
  }

  resetTools(s: McpServerSummary): void {
    this.patterns.value = patternsOf(s);
    this.picked.value = [];
    this.moved.value = [];
  }

  endpointDirty(s: McpServerSummary): boolean {
    const key = this.keyName.value === NO_KEY ? null : this.keyName.value;
    return this.url.value.trim() !== s.url || key !== s.keyName;
  }

  offerDirty(s: McpServerSummary): boolean {
    return this.read.value !== s.read || this.write.value !== s.write;
  }

  timeoutDirty(s: McpServerSummary): boolean {
    return timeoutMs(this.timeout.value) !== s.timeoutMs;
  }

  instructionsDirty(s: McpServerSummary): boolean {
    return this.instructionsOn.value !== s.instructionsOn;
  }

  toolsDirty(s: McpServerSummary): boolean {
    return !samePatterns(this.patterns.value, patternsOf(s));
  }

  // each card saves only its own fields: one at rest takes the row
  // another save or a refresh answered, an edited one stays
  follow(before: McpServerSummary, after: McpServerSummary): void {
    if (!this.endpointDirty(before)) this.resetEndpoint(after);
    if (!this.offerDirty(before)) this.resetOffer(after);
    if (!this.timeoutDirty(before)) this.resetTimeout(after);
    if (!this.instructionsDirty(before)) this.resetInstructions(after);
    if (!this.toolsDirty(before)) {
      this.patterns.value = patternsOf(after);
    }
    const names = new Set(after.tools.map((t) => t.name));
    if (this.picked.value.some((n) => !names.has(n))) {
      this.picked.value = this.picked.value.filter((n) => names.has(n));
    }
  }
}
