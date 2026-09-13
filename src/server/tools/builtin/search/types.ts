// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shapes the two search wires share: the argument the tool parsed,
// the request one wire builds and the error a wire raises when the
// provider answered with one.

export type SearchProvider = "exa" | "firecrawl";

export type SearchArgs = {
  query: string;
  domain: string | null;
};

export type ProviderRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly keyRejected = false,
  ) {
    super(message);
  }
}
