// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The instance's one Dictation setting as a document, applied through the
// Dictation routes, whose save checks the model against the provider's
// live transcription catalog. Its name is a label, as an SmtpServer's.

import type { DictationResponse } from "../../shared/api/dictation.ts";
import type { ProvidersResponse } from "../../shared/api/providers.ts";
import {
  servesTranscription,
  TRANSCRIPTION_WIRES,
} from "../../shared/contracts/dictation.ts";
import { isName } from "../../shared/words.ts";
import { parseModel } from "../lib/body.ts";
import { type Action, type Client, idOf, required } from "./client.ts";
import { boolean, guarded, optionalSpec } from "./fields.ts";

export type DictationSpec = {
  provider?: string;
  model?: string;
  // left out on an update the switch stays; a new one without it is off
  enabled?: boolean;
};

export function dictationSpec(value: unknown): DictationSpec {
  return optionalSpec<DictationSpec>(value, {
    provider: guarded(isName, "must be a provider name"),
    model: (v) => parseModel(v, null),
    enabled: boolean,
  });
}

// offline, before anything is written: a new one names provider and
// model, and the provider is known and on a transcription wire
export function checkDictation(
  doc: { source: string; name: string; spec: DictationSpec },
  documents: { kind: string; name: string; spec: object }[],
  inventory: { Dictation: string[]; Provider: string[] },
  providerWire: (name: string) => string | null,
): void {
  const fail = (field: string, message: string): never => {
    throw new Error(
      `${doc.source}: Dictation/${doc.name}: spec.${field} ${message}`,
    );
  };
  if (inventory.Dictation.length === 0) {
    for (const field of ["provider", "model"]) {
      if (!Object.hasOwn(doc.spec, field)) {
        fail(field, "is required for a new object");
      }
    }
  }
  const name = doc.spec.provider;
  if (name === undefined) return;
  const input = documents.find(
    (other) => other.kind === "Provider" && other.name === name,
  )?.spec as { wire?: string } | undefined;
  if (input === undefined && !inventory.Provider.includes(name)) {
    fail("provider", `references missing Provider/${name}`);
  }
  // a held provider's wire never changes, so its own one decides
  const wire = providerWire(name) ?? input?.wire ?? null;
  if (wire !== null && !servesTranscription(wire)) {
    fail(
      "provider",
      `Provider/${name} is on the ${wire} wire, which serves no transcription (${TRANSCRIPTION_WIRES.join(", ")})`,
    );
  }
}

export async function applyDictation(
  api: Client,
  doc: { spec: DictationSpec },
): Promise<Action> {
  const held = await api.call<DictationResponse>("GET", "/api/admin/dictation");
  let providerId = held.settings?.providerId;
  if (doc.spec.provider !== undefined) {
    const { providers } = await api.call<ProvidersResponse>(
      "GET",
      "/api/providers",
    );
    providerId = idOf(providers, doc.spec.provider);
  }
  const desired = {
    providerId: required(providerId, "provider"),
    model: required(doc.spec.model ?? held.settings?.model, "model"),
  };
  let changed = false;
  if (
    held.settings?.providerId !== desired.providerId ||
    held.settings.model !== desired.model
  ) {
    await api.call("PUT", "/api/admin/dictation", desired);
    changed = true;
  }
  // a first save starts off, so only a switch that differs is sent
  if (doc.spec.enabled !== undefined && doc.spec.enabled !== held.enabled) {
    await api.call("PATCH", "/api/admin/dictation", {
      enabled: doc.spec.enabled,
    });
    changed = true;
  }
  if (!changed) return "unchanged";
  return held.settings === null ? "created" : "updated";
}
