// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import type { AgentServer } from "../../shared/contracts/mcp.ts";
import type { CatalogMatch } from "../../shared/contracts/provider.ts";
import type { Avatar, Effort, McpMode } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

export type AgentRow = AgentSummary;

type Raw = {
  id: string;
  name: string;
  avatar: Avatar;
  provider_id: string;
  model: string;
  model_name: string;
  context_length: number | null;
  prompt_price: number | null;
  completion_price: number | null;
  tools: number;
  reasoning: number;
  thinking_required: number;
  reasoning_known: number;
  model_described: number;
  thinking: "on" | "off" | null;
  effort: Effort | null;
  prompt: string;
  mcp_mode: McpMode;
  upstream: string | null;
  created_at: number;
};

const row = (
  raw: Raw,
  skills: string[],
  servers: AgentServer[],
  defaultId: string | null,
): AgentRow => ({
  id: raw.id,
  name: raw.name,
  avatar: raw.avatar,
  providerId: raw.provider_id,
  model: {
    id: raw.model,
    name: raw.model_name,
    contextLength: raw.context_length,
    promptPrice: raw.prompt_price,
    completionPrice: raw.completion_price,
    tools: raw.tools === 1,
    reasoning: raw.reasoning === 1,
    thinkingRequired: raw.thinking_required === 1,
    reasoningKnown: raw.reasoning_known === 1,
    described: raw.model_described === 1,
  },
  thinking: raw.thinking,
  effort: raw.effort,
  prompt: raw.prompt,
  skills,
  servers,
  mcpMode: raw.mcp_mode,
  upstream: raw.upstream,
  default: raw.id === defaultId,
  createdAt: raw.created_at,
});

export const summary = (agent: AgentRow): AgentSummary => agent;

export type AgentFields = {
  name: string;
  avatar: Avatar;
  providerId: string;
  // a snapshot: the catalog may change or drop the model later
  model: CatalogMatch;
  thinking: "on" | "off" | null;
  effort: Effort | null;
  prompt: string;
  skills: string[];
  servers: AgentServer[];
  mcpMode: McpMode;
  upstream: string | null;
};

export class AgentStore {
  constructor(
    private readonly db: Db,
    private readonly assigned: (agentId: string) => string[],
    private readonly agentServers: (agentId: string) => AgentServer[],
  ) {}

  private row(raw: Raw, defaultId = this.defaultId()): AgentRow {
    return row(
      raw,
      this.assigned(raw.id),
      this.agentServers(raw.id),
      defaultId,
    );
  }

  // the marked agent, else the first created, so deleting the default
  // hands it on with no write
  defaultId(): string | null {
    return (
      this.db
        .query<{ id: string }, []>(
          "select id from agents order by is_default desc, created_at, name limit 1",
        )
        .get()?.id ?? null
    );
  }

  list(): AgentRow[] {
    const defaultId = this.defaultId();
    return this.db
      .query<Raw, []>("select * from agents order by created_at, name")
      .all()
      .map((raw) => this.row(raw, defaultId));
  }

  byId(id: string): AgentRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from agents where id = ?")
      .get(id);
    return raw ? this.row(raw) : null;
  }

  byName(name: string): AgentRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from agents where name = ?")
      .get(name);
    return raw ? this.row(raw) : null;
  }

  // true moves the mark here; false takes it off this agent only, so the
  // default goes back to the first created
  setDefault(id: string, on: boolean): void {
    if (on) {
      this.db
        .query(
          "update agents set is_default = 0 where is_default = 1 and id != ?",
        )
        .run(id);
    }
    this.db
      .query("update agents set is_default = ? where id = ?")
      .run(on ? 1 : 0, id);
  }

  usesProvider(providerId: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from agents where provider_id = ?",
        )
        .get(providerId)!.n > 0
    );
  }

  create(fields: AgentFields & { now: number }): AgentRow {
    const id = newId();
    const m = fields.model;
    this.db
      .query(
        `insert into agents (id, name, avatar, provider_id, model, model_name,
           context_length, prompt_price, completion_price, tools, reasoning,
           thinking_required, reasoning_known, model_described, thinking,
           effort, prompt, mcp_mode, upstream, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.name,
        fields.avatar,
        fields.providerId,
        m.id,
        m.name,
        m.contextLength,
        m.promptPrice,
        m.completionPrice,
        m.tools ? 1 : 0,
        m.reasoning ? 1 : 0,
        m.thinkingRequired ? 1 : 0,
        m.reasoningKnown ? 1 : 0,
        m.described ? 1 : 0,
        fields.thinking,
        fields.effort,
        fields.prompt,
        fields.mcpMode,
        fields.upstream,
        fields.now,
      );
    return this.byId(id)!;
  }

  update(id: string, fields: AgentFields): AgentRow | null {
    const m = fields.model;
    this.db
      .query(
        `update agents set name = ?, avatar = ?, provider_id = ?, model = ?, model_name = ?,
           context_length = ?, prompt_price = ?, completion_price = ?,
           tools = ?, reasoning = ?, thinking_required = ?,
           reasoning_known = ?, model_described = ?, thinking = ?,
           effort = ?, prompt = ?, mcp_mode = ?, upstream = ?
         where id = ?`,
      )
      .run(
        fields.name,
        fields.avatar,
        fields.providerId,
        m.id,
        m.name,
        m.contextLength,
        m.promptPrice,
        m.completionPrice,
        m.tools ? 1 : 0,
        m.reasoning ? 1 : 0,
        m.thinkingRequired ? 1 : 0,
        m.reasoningKnown ? 1 : 0,
        m.described ? 1 : 0,
        fields.thinking,
        fields.effort,
        fields.prompt,
        fields.mcpMode,
        fields.upstream,
        id,
      );
    return this.byId(id);
  }

  delete(id: string): boolean {
    return this.db.query("delete from agents where id = ?").run(id).changes > 0;
  }
}
