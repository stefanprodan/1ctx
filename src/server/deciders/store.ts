// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { DeciderSummary } from "../../shared/contracts/decider.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

export type DeciderRow = DeciderSummary;

type Raw = {
  id: string;
  name: string;
  provider_id: string;
  model: string;
  context_length: number | null;
  prompt_price: number | null;
  is_default: number;
  created_at: number;
};

const row = (raw: Raw, defaultId: string | null): DeciderRow => ({
  id: raw.id,
  name: raw.name,
  providerId: raw.provider_id,
  model: raw.model,
  contextLength: raw.context_length,
  promptPrice: raw.prompt_price,
  default: raw.id === defaultId,
  createdAt: raw.created_at,
});

export type DeciderFields = {
  name: string;
  providerId: string;
  model: string;
  // what the decisions catalog said when the model was picked
  contextLength: number | null;
  promptPrice: number | null;
};

export class DeciderStore {
  constructor(private readonly db: Db) {}

  // the marked decider, else the first created, so deleting the default
  // hands it on with no write
  defaultId(): string | null {
    return (
      this.db
        .query<{ id: string }, []>(
          `select id from deciders
           order by is_default desc, created_at, name limit 1`,
        )
        .get()?.id ?? null
    );
  }

  list(): DeciderRow[] {
    const defaultId = this.defaultId();
    return this.db
      .query<Raw, []>("select * from deciders order by created_at, name")
      .all()
      .map((raw) => row(raw, defaultId));
  }

  byId(id: string): DeciderRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from deciders where id = ?")
      .get(id);
    return raw ? row(raw, this.defaultId()) : null;
  }

  byName(name: string): DeciderRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from deciders where name = ?")
      .get(name);
    return raw ? row(raw, this.defaultId()) : null;
  }

  // true moves the mark here; false takes it off this decider only, so
  // the default goes back to the first created
  setDefault(id: string, on: boolean): void {
    if (on) {
      this.db
        .query(
          "update deciders set is_default = 0 where is_default = 1 and id != ?",
        )
        .run(id);
    }
    this.db
      .query("update deciders set is_default = ? where id = ?")
      .run(on ? 1 : 0, id);
  }

  usesProvider(providerId: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from deciders where provider_id = ?",
        )
        .get(providerId)!.n > 0
    );
  }

  create(fields: DeciderFields & { now: number }): DeciderRow {
    const id = newId();
    this.db
      .query(
        `insert into deciders (id, name, provider_id, model, context_length,
           prompt_price, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.name,
        fields.providerId,
        fields.model,
        fields.contextLength,
        fields.promptPrice,
        fields.now,
      );
    return this.byId(id)!;
  }

  update(id: string, fields: DeciderFields): DeciderRow | null {
    this.db
      .query(
        `update deciders set name = ?, provider_id = ?, model = ?,
           context_length = ?, prompt_price = ?
         where id = ?`,
      )
      .run(
        fields.name,
        fields.providerId,
        fields.model,
        fields.contextLength,
        fields.promptPrice,
        id,
      );
    return this.byId(id);
  }

  delete(id: string): boolean {
    return (
      this.db.query("delete from deciders where id = ?").run(id).changes > 0
    );
  }
}
