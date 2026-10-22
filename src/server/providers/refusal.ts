// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { errorFields, type LogFields } from "../lib/log.ts";

// A provider's refusal keeps its words for the chat row; a log names
// only its status, since the words are the response's body
export class ProviderRefusal extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

// a refusal's status for the send row, null for any other failure
export const refusalOf = (error: unknown): { status: number | null } | null =>
  error instanceof ProviderRefusal ? { status: error.status } : null;

export const REFUSED = "the provider answered with an error";

// what a log says of a refusal: the fixed phrase and the status, beside
// a status field that already names something else
export function refusalFields(status: number | null): LogFields {
  return {
    error: REFUSED,
    ...(status === null ? {} : { provider_status: status }),
  };
}

// the fields a failed provider call logs
export function failureFields(error: unknown): LogFields {
  return error instanceof ProviderRefusal
    ? refusalFields(error.status)
    : errorFields(error, false);
}
