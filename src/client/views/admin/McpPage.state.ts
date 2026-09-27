// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An MCP server page's drafts, one per card that saves apart: the
// endpoint, the sides and the timeout, the instructions switch, and the
// Tools tab's three matcher lists with its search, side, picks and the
// words of the last move. The page holds one per server, so a draft
// outlives a tab switch and goes with a pick of another server. Each
// card sends only its own fields, so a card at rest follows the row
// another card's save answered.

import { signal } from "@preact/signals";
import type { McpServerSummary } from "../../../shared/contracts/mcp.ts";
import type { Patterns } from "../../../shared/mcp.ts";
import { NO_KEY } from "../../lib/secrets.ts";
import { patternText, timeoutMs, timeoutText } from "./Mcp.model.ts";
import type { SideFilter } from "./McpTools.model.ts";

const patternsOf = (s: McpServerSummary): Patterns => ({
  read: s.readPatterns,
  write: s.writePatterns,
  excluded: s.excludedPatterns,
});

const samePatterns = (a: Patterns, b: Patterns) =>
  patternText(a.read) === patternText(b.read) &&
  patternText(a.write) === patternText(b.write) &&
  patternText(a.excluded) === patternText(b.excluded);

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

  constructor(readonly serverId: string) {}

  static of(server: McpServerSummary): McpDrafts {
    const d = new McpDrafts(server.id);
    d.resetEndpoint(server);
    d.resetSettings(server);
    d.resetInstructions(server);
    d.resetTools(server);
    return d;
  }

  resetEndpoint(s: McpServerSummary): void {
    this.url.value = s.url;
    this.keyName.value = s.keyName ?? NO_KEY;
  }

  resetSettings(s: McpServerSummary): void {
    this.read.value = s.read;
    this.write.value = s.write;
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

  settingsDirty(s: McpServerSummary): boolean {
    return (
      this.read.value !== s.read ||
      this.write.value !== s.write ||
      timeoutMs(this.timeout.value) !== s.timeoutMs
    );
  }

  instructionsDirty(s: McpServerSummary): boolean {
    return this.instructionsOn.value !== s.instructionsOn;
  }

  toolsDirty(s: McpServerSummary): boolean {
    return !samePatterns(this.patterns.value, patternsOf(s));
  }

  // a card no one touched takes the row another save or a refresh
  // answered; an edited one stays as it is
  follow(before: McpServerSummary, after: McpServerSummary): void {
    if (!this.endpointDirty(before)) this.resetEndpoint(after);
    if (!this.settingsDirty(before)) this.resetSettings(after);
    if (!this.instructionsDirty(before)) this.resetInstructions(after);
    if (!this.toolsDirty(before)) {
      this.patterns.value = patternsOf(after);
    }
    // a tool the refresh took away is no longer picked
    const names = new Set(after.tools.map((t) => t.name));
    if (this.picked.value.some((n) => !names.has(n))) {
      this.picked.value = this.picked.value.filter((n) => names.has(n));
    }
  }
}
