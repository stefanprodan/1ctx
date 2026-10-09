// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { AgentServer } from "../../../shared/contracts/mcp.ts";
import type { CatalogMatch } from "../../../shared/contracts/provider.ts";
import type { Avatar, Effort, McpMode, Wire } from "../../../shared/words.ts";
import { servers } from "../../data/mcp.ts";
import { skills } from "../../data/skills.ts";
import { sameIds } from "../../lib/ids.ts";
import { at, type Problem } from "../../lib/save.ts";
import {
  sameServers,
  sentEffort,
  statedFields,
  statedModel,
  statedProblem,
  windowText,
} from "./Agents.model.ts";
import { holding } from "./drafts.ts";

type ModelDraft = {
  providerId: string;
  model: CatalogMatch | null;
  thinking: "on" | "off" | null;
  effort: Effort | null;
  upstream: string | null;
  skip4Bit: boolean;
  windowText: string;
  windowSaved: number | null;
  takesTools: boolean;
  suggested: boolean;
};

export class AgentDrafts {
  readonly name = signal("");
  readonly avatar = signal<Avatar>("bot");
  readonly prompt = signal("");
  readonly isDefault = signal(false);

  readonly providerId = signal("");
  readonly model = signal<CatalogMatch | null>(null);
  readonly thinking = signal<"on" | "off" | null>(null);
  readonly effort = signal<Effort | null>(null);
  readonly upstream = signal<string | null>(null);
  readonly skip4Bit = signal(false);
  // in thousands, as typed
  readonly windowText = signal("");
  // the stored window the text was shown from, sent back when untouched
  windowSaved: number | null = null;
  readonly takesTools = signal(false);
  // the window and tools are models.dev's for the model picked, not yet
  // changed; the hint says so
  readonly suggested = signal(false);
  // the model the upstream was chosen for: a tag names a provider of it
  upstreamOf: string | null = null;
  readonly changing = signal(false);
  private before: ModelDraft | null = null;

  // every card waits for a save, so none undoes another
  readonly saving = signal(false);

  readonly skills = signal<string[]>([]);
  readonly servers = signal<AgentServer[]>([]);
  readonly mode = signal<McpMode>("auto");
  readonly subagents = signal(false);

  constructor(readonly agentId: string) {}

  static of(agent: AgentSummary): AgentDrafts {
    const drafts = new AgentDrafts(agent.id);
    drafts.resetGeneral(agent);
    drafts.resetModel(agent);
    drafts.resetSkills(agent);
    drafts.resetServers(agent);
    drafts.resetMode(agent);
    drafts.resetSubagents(agent);
    return drafts;
  }

  static blank(providerId: string): AgentDrafts {
    const drafts = new AgentDrafts("");
    drafts.providerId.value = providerId;
    drafts.changing.value = true;
    return drafts;
  }

  resetGeneral(agent: AgentSummary): void {
    this.name.value = agent.name;
    this.avatar.value = agent.avatar;
    this.prompt.value = agent.prompt;
    this.isDefault.value = agent.default;
  }

  resetModel(agent: AgentSummary): void {
    this.providerId.value = agent.providerId;
    this.model.value = agent.model;
    this.thinking.value = agent.thinking;
    this.effort.value = agent.effort;
    this.upstream.value = agent.upstream;
    this.skip4Bit.value = agent.skip4Bit;
    this.upstreamOf = agent.model.id;
    this.windowText.value = windowText(agent.model.contextLength);
    this.windowSaved = agent.model.contextLength;
    this.takesTools.value = agent.model.tools;
    this.suggested.value = false;
    this.changing.value = false;
    this.before = null;
  }

  resetSkills(agent: AgentSummary): void {
    this.skills.value = agent.skills;
  }

  resetServers(agent: AgentServer[] | AgentSummary): void {
    this.servers.value = Array.isArray(agent) ? agent : agent.servers;
  }

  resetMode(agent: AgentSummary): void {
    this.mode.value = agent.mcpMode;
  }

  resetSubagents(agent: AgentSummary): void {
    this.subagents.value = agent.subagents;
  }

  save<T>(call: () => Promise<T>): Promise<T> {
    return holding(this.saving, call);
  }

  // the row changed under the page: what the admin left alone follows;
  // another card's save answers the model as the catalog describes it now
  follow(before: AgentSummary, after: AgentSummary): void {
    if (this.name.value.trim() === before.name) this.name.value = after.name;
    if (this.avatar.value === before.avatar) this.avatar.value = after.avatar;
    if (this.prompt.value.trim() === before.prompt) {
      this.prompt.value = after.prompt;
    }
    if (this.isDefault.value === before.default) {
      this.isDefault.value = after.default;
    }
    if (!this.skillsDirty(before)) this.resetSkills(after);
    if (!this.serversDirty(before)) this.resetServers(after);
    if (!this.modeDirty(before)) this.resetMode(after);
    if (!this.subagentsDirty(before)) this.resetSubagents(after);
    const untouched =
      !this.changing.value &&
      this.providerId.value === before.providerId &&
      this.model.value === before.model &&
      this.thinking.value === before.thinking &&
      this.effort.value === before.effort &&
      this.upstream.value === before.upstream &&
      this.skip4Bit.value === before.skip4Bit &&
      this.windowText.value === windowText(before.model.contextLength) &&
      this.takesTools.value === before.model.tools;
    if (untouched) this.resetModel(after);
  }

  // Change keeps the saved model in the draft, so Thinking and Effort
  // stay until a pick or a provider change
  change(): void {
    this.before = {
      providerId: this.providerId.value,
      model: this.model.value,
      thinking: this.thinking.value,
      effort: this.effort.value,
      upstream: this.upstream.value,
      skip4Bit: this.skip4Bit.value,
      windowText: this.windowText.value,
      windowSaved: this.windowSaved,
      takesTools: this.takesTools.value,
      suggested: this.suggested.value,
    };
    this.changing.value = true;
  }

  get cancellable(): boolean {
    return this.before?.model != null;
  }

  cancel(): void {
    const b = this.before;
    if (b !== null) {
      this.providerId.value = b.providerId;
      this.model.value = b.model;
      this.thinking.value = b.thinking;
      this.effort.value = b.effort;
      this.upstream.value = b.upstream;
      this.skip4Bit.value = b.skip4Bit;
      this.windowText.value = b.windowText;
      this.windowSaved = b.windowSaved;
      this.takesTools.value = b.takesTools;
      this.suggested.value = b.suggested;
    }
    this.before = null;
    this.changing.value = false;
  }

  pick(model: CatalogMatch, resetThinking: boolean): void {
    this.model.value = model;
    if (model.id !== this.upstreamOf) this.upstream.value = null;
    this.upstreamOf = model.id;
    if (resetThinking) this.thinking.value = null;
    // an undescribed row carries models.dev's window and tools, if any:
    // the fields start there, and the exact window is sent untouched
    const suggested = !model.described && model.contextLength !== null;
    this.windowText.value = suggested ? windowText(model.contextLength) : "";
    this.windowSaved = suggested ? model.contextLength : null;
    this.takesTools.value = suggested && model.tools;
    this.suggested.value = suggested;
    this.before = null;
    this.changing.value = false;
  }

  chooseProvider(id: string): void {
    if (id === this.providerId.value) return;
    this.providerId.value = id;
    this.model.value = null;
    this.effort.value = null;
    this.upstream.value = null;
    this.skip4Bit.value = false;
  }

  generalDirty(agent: AgentSummary): boolean {
    return (
      this.name.value.trim() !== agent.name ||
      this.avatar.value !== agent.avatar ||
      this.prompt.value.trim() !== agent.prompt ||
      this.isDefault.value !== agent.default
    );
  }

  modelBody(wire: Wire | undefined) {
    const m = this.model.value!;
    return {
      providerId: this.providerId.value,
      model: m.id,
      thinking: this.thinking.value,
      effort: sentEffort(m, this.thinking.value, this.effort.value, wire),
      upstream: wire === "openrouter" ? this.upstream.value : null,
      skip4Bit: wire === "openrouter" ? this.skip4Bit.value : false,
      ...statedFields(
        m,
        this.windowText.value,
        this.takesTools.value,
        this.windowSaved,
      ),
    };
  }

  modelProblem(): Problem | null {
    return (
      at("model", this.model.value === null ? "Pick a model" : null) ??
      at(
        "contextLength",
        statedProblem(
          this.model.value,
          this.windowText.value,
          this.takesTools.value,
          this.windowSaved,
        ),
      )
    );
  }

  modelDirty(agent: AgentSummary, wire: Wire | undefined): boolean {
    const model = this.model.value;
    const window = this.windowText.value;
    const tools = this.takesTools.value;
    const saved = this.windowSaved;
    const picked = statedModel(model, window, tools, saved);
    return (
      this.providerId.value !== agent.providerId ||
      model?.id !== agent.model.id ||
      // a pick of the same model whose catalog now says more about its
      // thinking saves it
      model?.thinkingRequired !== agent.model.thinkingRequired ||
      model?.reasoningKnown !== agent.model.reasoningKnown ||
      model?.reasoning !== agent.model.reasoning ||
      // and one whose catalog now prices it, names its models.dev id or
      // its output cap
      model?.promptPrice !== agent.model.promptPrice ||
      model?.completionPrice !== agent.model.completionPrice ||
      model?.listedAs !== agent.model.listedAs ||
      model?.outputLimit !== agent.model.outputLimit ||
      this.thinking.value !== agent.thinking ||
      sentEffort(model, this.thinking.value, this.effort.value, wire) !==
        agent.effort ||
      this.upstream.value !== agent.upstream ||
      this.skip4Bit.value !== agent.skip4Bit ||
      picked?.contextLength !== agent.model.contextLength ||
      picked?.tools !== agent.model.tools ||
      // a window it cannot take reads as none, yet is an edit to refuse
      statedProblem(model, window, tools, saved) !== null
    );
  }

  skillsDirty(agent: AgentSummary): boolean {
    return !sameIds(this.skills.value, agent.skills);
  }

  serversDirty(agent: AgentSummary): boolean {
    return !sameServers(this.servers.value, agent.servers);
  }

  modeDirty(agent: AgentSummary): boolean {
    return this.mode.value !== agent.mcpMode;
  }

  subagentsDirty(agent: AgentSummary): boolean {
    return this.subagents.value !== agent.subagents;
  }
}

export const loadedRows = () => ({
  skills: skills.value,
  servers: servers.value,
});
