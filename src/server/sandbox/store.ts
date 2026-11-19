// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  SandboxNetwork,
  SandboxSettings,
  SandboxShell,
} from "../../shared/contracts/sandbox.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

type Raw = {
  shell: SandboxShell;
  endpoint: string | null;
  image: string | null;
  instance_id: string | null;
  network: SandboxNetwork;
  hosts: string | null;
  updated_at: number;
};

export type SavedFields = Pick<
  SandboxSettings,
  "shell" | "endpoint" | "image" | "network" | "hosts"
>;

// the one settings row, made by its migration; the instance id at its
// first read
export class SandboxStore {
  constructor(private readonly db: Db) {}

  settings(): SandboxSettings {
    let raw = this.raw();
    // a read only, but the first: every command asks
    if (raw.instance_id === null) {
      this.db
        .query(
          "update sandbox_settings set instance_id = ? where id = 1 and instance_id is null",
        )
        .run(newId());
      raw = this.raw();
    }
    return {
      shell: raw.shell,
      endpoint: raw.endpoint,
      image: raw.image,
      network: raw.network,
      hosts: raw.hosts === null ? null : (JSON.parse(raw.hosts) as string[]),
      instanceId: raw.instance_id!,
      updatedAt: raw.updated_at,
    };
  }

  private raw(): Raw {
    return this.db
      .query<Raw, []>(
        "select shell, endpoint, image, instance_id, network, hosts, updated_at from sandbox_settings where id = 1",
      )
      .get()!;
  }

  save(fields: SavedFields, now: number): void {
    this.db
      .query(
        `update sandbox_settings
           set shell = ?, endpoint = ?, image = ?, network = ?, hosts = ?,
               updated_at = ?
         where id = 1`,
      )
      .run(
        fields.shell,
        fields.endpoint,
        fields.image,
        fields.network,
        fields.hosts === null ? null : JSON.stringify(fields.hosts),
        now,
      );
  }
}
