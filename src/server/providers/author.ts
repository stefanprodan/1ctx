// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// the mark that opens a message with its author's name where the wire
// carries no author: another agent's answer in a history, and every
// named user message on a wire with no name field (azure.ts)
export const markOf = (name: string) => `[${name}] `;
