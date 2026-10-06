// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A Decider object applied through the deciders API, whose save checks
// the model against the provider's live decisions catalog.

import type { DecidersResponse } from "../../shared/api/deciders.ts";
import type { ProvidersResponse } from "../../shared/api/providers.ts";
import { type Action, type Client, idOf, required } from "./client.ts";
import type { Of } from "./parse.ts";

export async function decider(
  api: Client,
  doc: Of<"Decider">,
): Promise<Action> {
  const { deciders } = await api.call<DecidersResponse>("GET", "/api/deciders");
  const before = deciders.find((row) => row.name === doc.name);
  let providerId = before?.providerId;
  if (doc.spec.provider !== undefined) {
    const { providers } = await api.call<ProvidersResponse>(
      "GET",
      "/api/providers",
    );
    providerId = idOf(providers, doc.spec.provider);
  }
  const provider = required(providerId, "provider");
  const model = required(doc.spec.model ?? before?.model, "model");
  const mark = doc.spec.default === true ? { default: true } : {};
  if (
    before &&
    before.providerId === provider &&
    before.model === model &&
    (doc.spec.default !== true || before.default)
  ) {
    return "unchanged";
  }
  await api.call(
    before ? "PATCH" : "POST",
    before ? `/api/deciders/${before.id}` : "/api/deciders",
    { name: doc.name, providerId: provider, model, ...mark },
  );
  return before ? "updated" : "created";
}
