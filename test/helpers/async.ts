// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export function deferred<T>() {
  return Promise.withResolvers<T>();
}

export const settle = () => new Promise<void>((r) => setTimeout(r, 0));
