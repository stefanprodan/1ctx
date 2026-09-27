// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A Decider object applied through the deciders API, whose save checks
// the model against the provider's live decisions catalog.

import type { DecidersResponse } from "../../shared/api/deciders.ts";
import type { ProvidersResponse } from "../../shared/api/providers.ts";
import type { Client } from "./client.ts";
import type { Document } from "./parse.ts";

type Of<K extends Document["kind"]> = Extract<Document, { kind: K }>;

export async function decider(
  api: Client,
  doc: Of<"Decider">,
): Promise<"created" | "updated" | "unchanged"> {
  const { deciders } = await api.call<DecidersResponse>("GET", "/api/deciders");
  const before = deciders.find((row) => row.name === doc.name);
  let providerId = before?.providerId;
  if (doc.spec.provider !== undefined) {
    const { providers } = await api.call<ProvidersResponse>(
      "GET",
      "/api/providers",
    );
    providerId = providers.find((row) => row.name === doc.spec.provider)?.id;
    if (providerId === undefined) {
      throw new Error(`no such reference ${doc.spec.provider}`);
    }
  }
  if (providerId === undefined) throw new Error("spec.provider is required");
  const model = doc.spec.model ?? before?.model;
  if (model === undefined) throw new Error("spec.model is required");
  const mark = doc.spec.default === true ? { default: true } : {};
  if (
    before &&
    before.providerId === providerId &&
    before.model === model &&
    (doc.spec.default !== true || before.default)
  ) {
    return "unchanged";
  }
  await api.call(
    before ? "PATCH" : "POST",
    before ? `/api/deciders/${before.id}` : "/api/deciders",
    { name: doc.name, providerId, model, ...mark },
  );
  return before ? "updated" : "created";
}
